package puppetloom.exporter

import kotlinx.serialization.json.*
import org.umamo.runtime.model.*
import org.umamo.interop.cmo3.Cmo3Conversion
import org.umamo.interop.cmo3.Cmo3Import
import org.umamo.interop.moc3.Moc3Sidecars
import org.umamo.interop.moc3.import.Moc3Import
import org.umamo.format.cmo3.Cmo3
import org.umamo.format.cmo3.model.custom.CModelSource
import org.umamo.format.moc3.Moc3
import java.nio.file.Files
import java.nio.file.Path
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

private fun JsonObject.s(key:String) = getValue(key).jsonPrimitive.content
private fun JsonObject.f(key:String) = getValue(key).jsonPrimitive.float
private fun JsonElement.floats() = jsonArray.map { it.jsonPrimitive.float }.toFloatArray()
private fun JsonElement.ints() = jsonArray.map { it.jsonPrimitive.int }.toIntArray()

fun main(args:Array<String>) {
  if(args[0]=="--inspect-cmo3") {
    val model=Cmo3.read(Files.readAllBytes(Path.of(args[1])))
    Files.write(Path.of(args[2]),model.archive.entries.first { it.path=="main.xml" }.content)
    val puppet=Cmo3Import.fromModelSource(model.root as CModelSource)
    val dump=buildJsonArray {for(d in puppet.drawables)add(buildJsonObject {
      put("id",d.id.raw);put("order",d.drawOrder);put("opacity",d.opacity)
      put("uvs",buildJsonArray {d.mesh!!.uvs.forEach {add(it)}})
      val grid=d.geometryGrid
      val cell=grid?.cells?.find { c -> grid.axes.indices.all {i->grid.axes[i].keys[c.coordinate[i]]==puppet.parameters.first {it.id==grid.axes[i].parameterId}.default} }
      put("positions",buildJsonArray {d.mesh!!.positions.forEachIndexed {i,v->add(v+(cell?.form?.positionDeltas?.get(i)?:0f))}})
    })}
    Files.writeString(Path.of(args[2]+".json"),dump.toString())
    return
  }
  val input=Path.of(args[0]); val out=Path.of(args[1]); Files.createDirectories(out)
  val doc=Json.parseToJsonElement(Files.readString(input)).jsonObject
  val editorTarget=doc["editorVersion"]?.jsonPrimitive?.content ?: "5.3"
  val runtimeTarget=when(doc["runtimeVersion"]?.jsonPrimitive?.content ?: "5.0") {
    "4.2" -> RuntimeTarget.Cubism42
    "5.0" -> RuntimeTarget.Cubism50
    "5.3" -> RuntimeTarget.Cubism53
    else -> error("Unsupported runtime target")
  }
  val parameters=doc.getValue("parameters").jsonArray.map { val p=it.jsonObject; Parameter(ParameterId(p.s("id")),p.s("name"),p.f("min"),p.f("max"),p.f("default")) }
  val pages=doc.getValue("textures").jsonArray.map { val p=it.jsonObject; Cmo3Conversion.AtlasPage(Files.readAllBytes(input.parent.resolve(p.s("file"))),p.getValue("width").jsonPrimitive.int,p.getValue("height").jsonPrimitive.int) }
  check(pages.all { it.width in 256..16384 && it.height in 256..16384 && (it.width and (it.width-1))==0 && (it.height and (it.height-1))==0 }) {
    "Cubism requires power-of-two atlas pages; cropped layer PNGs must be packed before conversion."
  }
  val draws=doc.getValue("layers").jsonArray.map { entry ->
    val d=entry.jsonObject
    val axes=d.getValue("axes").jsonArray.map { val a=it.jsonObject; KeyformAxis(ParameterId(a.s("id")),a.getValue("keys").floats()) }
    val points=d.getValue("positions").floats()
    val count=d.getValue("count").jsonPrimitive.int
    val data=ByteBuffer.wrap(Files.readAllBytes(input.parent.resolve(d.s("data")))).order(ByteOrder.LITTLE_ENDIAN)
    check(data.remaining()==count*(points.size+2)*4)
    val positions=ArrayList<FloatArray>();val opacity=ArrayList<Float>();val order=ArrayList<Float>()
    repeat(count) { positions.add(FloatArray(points.size) { data.float });opacity.add(data.float);order.add(data.float) }
    fun coordinate(index:Int):IntArray { var n=index;return axes.map { val i=n%it.keys.size;n/=it.keys.size;i }.toIntArray() }
    val grid=KeyformGrid(axes,positions.mapIndexed { i,p -> KeyformCell(coordinate(i),MeshDeltaForm(p.mapIndexed { j,v -> v-points[j] }.toFloatArray())) })
    fun channel(values:List<Float>)=KeyformGrid<ChannelValue>(axes,values.mapIndexed { i,v -> KeyformCell(coordinate(i),ChannelValue.Scalar(v)) })
    Drawable(id=DrawableId(d.s("id")),name=d.s("name"),parentDeformerId=null,
      blendMode=BlendMode.entries.first { it.name.equals(d.s("blend"),true) },
      maskedBy=d.getValue("masks").jsonArray.map { DrawableId(it.jsonPrimitive.content) },
      mesh=DrawableMesh(points,d.getValue("uvs").floats(),d.getValue("triangles").ints()),geometryGrid=grid,
      channelGrids=ChannelGrids(mapOf(FormChannel.OPACITY to channel(opacity),FormChannel.DRAW_ORDER to channel(order.map { it.roundToInt().toFloat() }))),
      drawOrder=d.f("order").roundToInt().toFloat(),opacity=d.f("opacity"),texturePage=d.getValue("texture").jsonPrimitive.int)
  }
  val model=PuppetModel(parameters=parameters,parameterTree=parameters.map { ParameterNode.Param(it.id) },parts=emptyList(),deformers=emptyList(),drawables=draws,
    rootChildren=draws.reversed().map { OrgChild.Drawable(it.id) },rootPartId=null,
    canvasWidth=doc.f("width"),canvasHeight=doc.f("height"),worldOriginX=doc.f("width")/2,worldOriginY=-doc.f("height")/2,
    pixelsPerUnit=doc.f("height"),runtimeTarget=runtimeTarget)
  val name=doc.s("name")
  val runtime=Moc3Sidecars.bundle(model,name,pages=pages.mapIndexed { i,p -> Moc3Sidecars.AtlasPage("textures/texture_$i.png",p.pngBytes) })
  for (file in runtime.files) { val path=out.resolve(file.name);Files.createDirectories(path.parent);Files.write(path,file.bytes) }
  val editable=Cmo3Conversion.freshCmo3(model,pages,draws.associate { it.id.raw to it.texturePage },name,0L,0x42)
  val notices=runtime.report.notices+editable.report.notices
  check(notices.all { it.toString().startsWith("MissingSourceArt(") }) { "Conversion would lose authored content: $notices" }
  val physicsCount=injectPhysics(editable.model.root as CModelSource,doc["physics"] as? JsonObject)
  Files.write(out.resolve("$name.cmo3"),editorProfile(Cmo3.write(editable.model),editorTarget))
  val moc=Moc3Import.fromMocDocument(Moc3.read(Files.readAllBytes(out.resolve("$name.moc3"))),null)
  val cmo=Cmo3Import.fromModelSource(Cmo3.read(Files.readAllBytes(out.resolve("$name.cmo3"))).root as CModelSource)
  check(moc.drawables.size==draws.size && cmo.drawables.size==draws.size) { "Export readback lost drawables" }
  check(moc.parameters.size==parameters.size && cmo.parameters.size==parameters.size) { "Export readback lost parameters" }
  val report=buildJsonObject { put("drawables",draws.size);put("parameters",parameters.size);put("physicsSettings",physicsCount);put("readback",true);put("editorVersion",editorTarget);put("runtimeVersion",runtimeTarget.displayName)
    put("notices",buildJsonArray { for(n in runtime.report.notices+editable.report.notices) add(n.toString()) }) }
  Files.writeString(out.resolve("codec-report.json"),report.toString())
  println(report)
}
