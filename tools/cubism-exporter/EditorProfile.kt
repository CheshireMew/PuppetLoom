package puppetloom.exporter

import org.umamo.format.cmo3.caff.CaffCodec
import org.umamo.format.cmo3.caff.CaffEntry

/** Profile for our freshly generated graph, compared with Cubism Editor 5.3.01's
 * own save of the same model. This is not a general CMO3 downgrade converter.
 * Geometry, keyforms, images, masks and physics are retained byte-for-byte in XML.
 */
fun editorProfile(bytes: ByteArray, target: String): ByteArray {
  require(target == "5.3" || target == "5.4") { "Supported editor profiles: 5.3, 5.4" }
  if (target == "5.4") return bytes
  val archive = CaffCodec.read(bytes)
  val entries = archive.entries.map { entry ->
    if (entry.path != "main.xml") return@map entry
    var xml = entry.content.toString(Charsets.UTF_8)
    check(xml.contains("fileFormatVersion=\"504000000\"") && xml.contains("<?version CModelSource:16?>")) {
      "Converter schema changed; the 5.3 profile must be revalidated in Cubism Editor."
    }
    // 5.4-only state-set container is allowed ONLY when empty. Never discard states.
    val states = Regex("<CModelStateSetSet\\b[^>]*>[\\s\\S]*?</CModelStateSetSet>")
    for (block in states.findAll(xml)) check(Regex("<CModelStateSetSet xs.n=\"modelStateSetSet\">\\s*<carray_list xs.n=\"_modelStateSets\" count=\"0\"\\s*/>\\s*</CModelStateSetSet>").matches(block.value)) {
      "Non-empty 5.4 model states cannot be exported to Editor 5.3."
    }
    xml = states.replace(xml, "")
    // 5.3 stores no per-material auto-layout lock. Only the fresh default is removable.
    val locks = Regex("<AutoLayoutLock\\b[^>]*/>")
    for (block in locks.findAll(xml)) check(block.value.contains("v=\"NONE\"")) {
      "Non-default atlas layout locks require Editor 5.4."
    }
    xml = locks.replace(xml, "")
    check(!xml.contains("<CModelStateSet") && !xml.contains("<AutoLayoutLock"))
    xml = xml.replace("<?version ModelStateSet:1?>", "")
      .replace("<?version CModelSource:16?>", "<?version CModelSource:15?>")
      .replace(Regex("<\\?import [^?]*\\.(?:CModelStateSetSet|AutoLayoutLock)\\?>"), "")
      .replace("fileFormatVersion=\"504000000\"", "fileFormatVersion=\"503010000\"")
    CaffEntry(entry.path, entry.tag, xml.toByteArray(Charsets.UTF_8), entry.compression, entry.obfuscated)
  }
  return CaffCodec.write(archive.withEntries(entries))
}
