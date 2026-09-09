package puppetloom.exporter

import kotlinx.serialization.json.*
import java.nio.file.Files
import java.nio.file.Path

/** Optional oracle: uses the user's installed official Core, never bundles it. */
fun main(args:Array<String>) {
  Class.forName("com.live2d.sdk.cubism.core.Live2DCubismCoreJNI")
  val mocClass=Class.forName("com.live2d.sdk.cubism.core.CubismMoc")
  val moc=mocClass.getMethod("instantiate",ByteArray::class.java).invoke(null,Files.readAllBytes(Path.of(args[1])))
  val model=mocClass.getMethod("instantiateModel").invoke(moc)
  fun call(obj:Any,name:String)=obj.javaClass.getMethod(name).invoke(obj)
  val params=call(model,"getParameterViews") as Array<*>
  val drawableViews=call(model,"getDrawableViews") as Array<*>
  val canvas=call(model,"getCanvasInfo")
  val ppu=call(canvas,"getPixelsPerUnit") as Float
  val origin=call(canvas,"getOriginInPixels") as FloatArray
  val poses=Json.parseToJsonElement(Files.readString(Path.of(args[2]))).jsonArray
  val result=buildJsonArray {
    for(pose in poses) {
      val values=pose.jsonObject.getValue("parameters").jsonObject
      for(p in params.filterNotNull()) {
        val id=call(p,"getId") as String
        p.javaClass.getMethod("setValue",Float::class.javaPrimitiveType).invoke(p,values[id]?.jsonPrimitive?.float?:call(p,"getDefaultValue"))
      }
      call(model,"update")
      add(buildJsonObject { put("id",pose.jsonObject.getValue("id"));put("layers",buildJsonArray {
        for(d in drawableViews.filterNotNull())add(buildJsonObject {
          put("id",call(d,"getId") as String);put("order",call(d,"getDrawOrder") as Int);put("opacity",call(d,"getOpacity") as Float)
          put("positions",buildJsonArray {val pts=call(d,"getVertexPositions") as FloatArray;for(i in pts.indices)add(if(i%2==0)pts[i]*ppu+origin[0] else origin[1]-pts[i]*ppu)})
          put("uvs",buildJsonArray {(call(d,"getVertexUvs") as FloatArray).forEach { add(it) }})
          put("indices",buildJsonArray {(call(d,"getIndices") as ShortArray).forEach { add(it.toInt() and 65535) }})
        })
      }) })
    }
  }
  Files.writeString(Path.of(args[3]),result.toString())
  call(model,"close");call(moc,"close")
  println("Official Core loaded model and evaluated ${poses.size} poses")
}
