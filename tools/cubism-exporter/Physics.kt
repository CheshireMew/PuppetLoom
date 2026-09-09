package puppetloom.exporter

import kotlinx.serialization.json.*
import org.umamo.format.cmo3.model.custom.CModelSource
import org.umamo.format.cmo3.model.gen.*
import org.umamo.format.cmo3.model.identity.Guid
import org.umamo.format.cmo3.model.identity.Id
import org.umamo.format.cmo3.model.type.GVector2
import org.umamo.format.cmo3.type.CArrayList
import java.util.UUID

/** Convert the same physics3 document into editable Editor physics settings. */
internal fun injectPhysics(root:CModelSource,physics:JsonObject?):Int {
  if(physics==null)return 0
  fun elements(v:Any?):List<Any?> = when(v){is Iterable<*>->v.toList();is Array<*>->v.toList();else->emptyList()}
  fun guid(kind:String,label:String)=Guid(kind).apply {uuid=UUID.nameUUIDFromBytes(label.toByteArray()).toString();note=label}
  fun vector(x:Float,y:Float)=GVector2().apply {this.x=x;this.y=y}
  fun JsonObject.f(k:String)=getValue(k).jsonPrimitive.float
  fun JsonObject.s(k:String)=getValue(k).jsonPrimitive.content
  fun type(t:String)=when(t){"X"->CPhysicsSourceType.SRC_TO_X;"Angle"->CPhysicsSourceType.SRC_TO_G_ANGLE;else->error("Unsupported editable physics type: $t")}
  val parameters=elements((root.parameterSourceSet as CParameterSourceSet)._sources).filterIsInstance<CParameterSource>().associateBy {(it.id as Id).idstr}
  val set=root.physicsSettingsSourceSet as CPhysicsSettingsSourceSet
  val entries=CArrayList<Any?>();set._sourceCubismPhysics=entries
  for((i,entry)in physics.getValue("PhysicsSettings").jsonArray.withIndex()) {
    val p=entry.jsonObject
    entries.add(CPhysicsSettingsSource().apply {
      name=p.s("Id");id=Id("CPhysicsSettingId").apply {idstr=p.s("Id")};guid=guid("CPhysicsSettingsGuid",p.s("Id"))
      inputs=CArrayList<Any?>(p.getValue("Input").jsonArray.mapIndexed {j,v->val x=v.jsonObject;CPhysicsInput().apply {
        guid=guid("CPhysicsDataGuid","input-$i-$j");source=parameters.getValue(x.getValue("Source").jsonObject.s("Id")).guid
        angleScale=0f;translationScale=vector(0f,0f);weight=x.f("Weight");type=type(x.s("Type"));isReverse=x.getValue("Reflect").jsonPrimitive.boolean
      }})
      outputs=CArrayList<Any?>(p.getValue("Output").jsonArray.mapIndexed {j,v->val x=v.jsonObject;CPhysicsOutput().apply {
        guid=guid("CPhysicsDataGuid","output-$i-$j");destination=parameters.getValue(x.getValue("Destination").jsonObject.s("Id")).guid
        vertexIndex=x.getValue("VertexIndex").jsonPrimitive.int;val t=x.s("Type");val scale=x.f("Scale")
        translationScale=vector(if(t=="X")scale else 0f,if(t=="Y")scale else 0f);angleScale=if(t=="Angle")scale else 0f
        weight=x.f("Weight");type=type(t);isReverse=x.getValue("Reflect").jsonPrimitive.boolean
      }})
      vertices=CArrayList<Any?>(p.getValue("Vertices").jsonArray.mapIndexed {j,v->val x=v.jsonObject;CPhysicsVertex().apply {
        guid=guid("CPhysicsDataGuid","vertex-$i-$j");val xy=x.getValue("Position").jsonObject;position=vector(xy.f("X"),xy.f("Y"))
        mobility=x.f("Mobility");delay=x.f("Delay");acceleration=x.f("Acceleration");radius=x.f("Radius")
      }})
      val n=p.getValue("Normalization").jsonObject;val pos=n.getValue("Position").jsonObject;val angle=n.getValue("Angle").jsonObject
      normalizedPositionValueMin=pos.f("Minimum");normalizedPositionValueMax=pos.f("Maximum");normalizedPositionDefaultValue=pos.f("Default")
      normalizedAngleValueMin=angle.f("Minimum");normalizedAngleValueMax=angle.f("Maximum");normalizedAngleDefaultValue=angle.f("Default")
    })
  }
  set.settingFPS=physics.getValue("Meta").jsonObject["Fps"]?.jsonPrimitive?.int?:30
  return entries.size
}
