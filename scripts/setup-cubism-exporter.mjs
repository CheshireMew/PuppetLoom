import { spawn,spawnSync } from 'node:child_process';
import { readFile,writeFile,mkdir,access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const option=(name,fallback)=>{const i=process.argv.indexOf(name);if(i>=0&&!process.argv[i+1])throw new Error(`Missing ${name} value`);return i<0?fallback:process.argv[i+1];};
const exists=async path=>{try{await access(path);return true;}catch{return false;}};
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const run=(command,args)=>new Promise((done,reject)=>{const child=spawn(command,args,{stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?done():reject(new Error(`${command} exited ${code}`)));});
const lock=JSON.parse(await readFile(join(root,'tools/cubism-exporter/dependencies.lock.json'),'utf8'));
const cache=resolve(option('--cache',process.env.PUPPETLOOM_EXPORT_CACHE??'D:/Tools/PuppetLoom/cubism-exporter'));
const download=async (item,path)=>{
  await mkdir(dirname(path),{recursive:true});
  if(!await exists(path)){
    console.log(`Downloading ${item.url} to ${path}`);
    const response=await fetch(item.url);if(!response.ok||!response.body)throw new Error(`Download failed: ${response.status}`);
    await pipeline(response.body,createWriteStream(path,{flags:'wx'}));
  }
  if(await hash(path)!==item.sha256)throw new Error(`SHA-256 mismatch: ${path}. Preserve/rename this incomplete file before retrying.`);
};
const localJava='D:/Java/TemurinJDK21-20260901/jdk-21.0.12.1+1/bin/java.exe';
const java=option('--java',process.env.PUPPETLOOM_EXPORT_JAVA??(process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin/java.exe'):await exists(localJava)?localJava:'java'));
const version=spawnSync(java,['-version'],{encoding:'utf8',windowsHide:true});
const major=Number((version.stderr??'').match(/version "(\d+)/)?.[1]);
if(version.error||version.status!==0||major<21||!major)throw new Error('Java 21+ is required; pass --java D:/path/to/bin/java.exe or set JAVA_HOME.');
const localLibs='D:/Tools/PSD2Live-reference-20260907/PSD2Live/app';
let libs=option('--libs',process.env.PUPPETLOOM_UMAMO_LIB??(await exists(localLibs)?localLibs:join(cache,'psd2live-0.4.0/PSD2Live/app')));
if(!await exists(libs)){
  if(process.argv.includes('--libs')||process.env.PUPPETLOOM_UMAMO_LIB)throw new Error(`Library directory does not exist: ${libs}`);
  const archive=join(cache,'PSD2Live-0.4.0-windows-x86_64-portable.zip');await download(lock.reference,archive);
  const destination=join(cache,'psd2live-0.4.0');
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  await run('powershell.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)}`]);
}
const jars=[],dependencies=[];
for(const entry of lock.jars){const path=join(libs,entry.file);if(await hash(path)!==entry.sha256)throw new Error(`Wrong dependency version/content: ${path}`);jars.push(path);dependencies.push({path,sha256:entry.sha256});}
const localCompiler='D:/Tools/Gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-compiler-embeddable/2.2.20/bb8331b7585e36ea311825b01a1c06860c055fd1/kotlin-compiler-embeddable-2.2.20.jar';
const compiler=option('--compiler',process.env.PUPPETLOOM_KOTLIN_COMPILER??(await exists(localCompiler)?localCompiler:join(cache,'kotlin-compiler-embeddable-2.2.20.jar')));
await download(lock.compiler,compiler);
const sources=['Main.kt','Physics.kt','CoreProbe.kt','EditorProfile.kt'].map(file=>join(root,'tools/cubism-exporter',file));
const sourceSha256=createHash('sha256');for(const file of sources)sourceSha256.update(await readFile(file));
const sourceHash=sourceSha256.digest('hex'),classes=join(root,'runtime/cubism-exporter/classes',sourceHash);await mkdir(classes,{recursive:true});
await run(java,['-cp',[compiler,...jars].join(';'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-Xskip-metadata-version-check','-no-stdlib','-no-reflect','-jvm-target','21','-classpath',jars.join(';'),'-d',classes,...sources]);
const config={java,classpath:[classes,...jars].join(';'),sourceSha256:sourceHash,dependencies,referenceVersion:lock.reference.version};
await writeFile(join(root,'runtime/cubism-exporter/config.json'),JSON.stringify(config,null,2));
console.log('Cubism exporter configured: '+join(root,'runtime/cubism-exporter/config.json'));
