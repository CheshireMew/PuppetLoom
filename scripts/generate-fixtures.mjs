import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writePsdBuffer } from "ag-psd";
import sharp from "sharp";

const fixtureDirectory = resolve("test/fixtures");
await mkdir(fixtureDirectory, { recursive: true });

function pixels(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

function setPixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const index = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  image.data[index] = color[0];
  image.data[index + 1] = color[1];
  image.data[index + 2] = color[2];
  image.data[index + 3] = color[3] ?? 255;
}

function ellipse(image, cx, cy, rx, ry, color) {
  const left = Math.max(0, Math.floor(cx - rx));
  const right = Math.min(image.width - 1, Math.ceil(cx + rx));
  const top = Math.max(0, Math.floor(cy - ry));
  const bottom = Math.min(image.height - 1, Math.ceil(cy + ry));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d <= 1) setPixel(image, x, y, color);
    }
  }
}

function rectangle(image, x, y, width, height, color) {
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(image.height, Math.ceil(y + height)); py += 1) {
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(image.width, Math.ceil(x + width)); px += 1) setPixel(image, px, py, color);
  }
}

function polygon(image, points, color) {
  const minX = Math.max(0, Math.floor(Math.min(...points.map((point) => point[0]))));
  const maxX = Math.min(image.width - 1, Math.ceil(Math.max(...points.map((point) => point[0]))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
  const maxY = Math.min(image.height - 1, Math.ceil(Math.max(...points.map((point) => point[1]))));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const a = points[i];
        const b = points[j];
        if (((a[1] > y) !== (b[1] > y)) && x < (b[0] - a[0]) * (y - a[1]) / ((b[1] - a[1]) || 1e-9) + a[0]) inside = !inside;
      }
      if (inside) setPixel(image, x, y, color);
    }
  }
}

function line(image, x1, y1, x2, y2, thickness, color) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let step = 0; step <= steps; step += 1) {
    const t = steps === 0 ? 0 : step / steps;
    ellipse(image, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, thickness * 0.5, thickness * 0.5, color);
  }
}

function layer(name, width, height, draw, extra = {}) {
  const imageData = pixels(width, height);
  draw(imageData);
  return { name, imageData, blendMode: "normal", opacity: 1, ...extra };
}

function composite(width, height, layers) {
  const output = pixels(width, height);
  const leaves = [];
  const collect = (items) => items.forEach((item) => item.children ? collect(item.children) : leaves.push(item));
  collect(layers);
  for (const item of leaves) {
    const source = item.imageData;
    if (!source || item.hidden) continue;
    const opacity = item.opacity ?? 1;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const index = pixel * 4;
      const sourceAlpha = (source.data[index + 3] ?? 0) / 255 * opacity;
      if (sourceAlpha <= 0) continue;
      const targetAlpha = (output.data[index + 3] ?? 0) / 255;
      const alpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel += 1) {
        const sourceColor = source.data[index + channel] ?? 0;
        const targetColor = output.data[index + channel] ?? 0;
        output.data[index + channel] = alpha === 0 ? 0 : Math.round((sourceColor * sourceAlpha + targetColor * targetAlpha * (1 - sourceAlpha)) / alpha);
      }
      output.data[index + 3] = Math.round(alpha * 255);
    }
  }
  return output;
}

function standardLayers(width, height, { combinedEyes = false, strangeNames = false, layerCount = 0 } = {}) {
  const sx = width / 512;
  const sy = height / 512;
  const X = (value) => value * sx;
  const Y = (value) => value * sy;
  const skin = [249, 211, 199, 255];
  const ink = [65, 52, 78, 255];
  const hair = [91, 72, 142, 255];
  const hairLight = [125, 101, 178, 255];
  const white = [247, 247, 252, 255];
  const eye = [74, 164, 196, 255];
  const names = strangeNames ? {
    back: "後ろ髪", body: "衣服", neck: "首", face: "顔", whiteR: "右 眼白", whiteL: "左 眼白", irisR: "右 瞳", irisL: "左 瞳",
    lashR: "右 まつ毛", lashL: "左 まつ毛", browR: "右 眉", browL: "左 眉", nose: "鼻", mouth: "口", front: "前髪", accessory: "装飾"
  } : {
    back: "back_hair", body: "top_wear", neck: "neck", face: "face", whiteR: "eye_white_right", whiteL: "eye_white_left", irisR: "iris_right", irisL: "iris_left",
    lashR: "eyelash_right", lashL: "eyelash_left", browR: "eyebrow_right", browL: "eyebrow_left", nose: "nose", mouth: "mouth", front: "front_hair", accessory: "accessory_ribbon"
  };
  const layers = [
    layer(names.back, width, height, (p) => { ellipse(p, X(256), Y(205), X(128), Y(154), hair); polygon(p, [[X(142),Y(220)],[X(118),Y(438)],[X(197),Y(340)]], hair); polygon(p, [[X(370),Y(220)],[X(394),Y(438)],[X(315),Y(340)]], hair); }),
    layer(names.body, width, height, (p) => { polygon(p, [[X(158),Y(350)],[X(354),Y(350)],[X(418),Y(510)],[X(94),Y(510)]], [76, 85, 145, 255]); polygon(p, [[X(207),Y(350)],[X(256),Y(420)],[X(305),Y(350)]], white); }),
    layer("arm_right", width, height, (p) => line(p, X(165), Y(380), X(110), Y(495), X(30), skin)),
    layer("arm_left", width, height, (p) => line(p, X(347), Y(380), X(402), Y(495), X(30), skin)),
    layer(names.neck, width, height, (p) => rectangle(p, X(225), Y(322), X(62), Y(73), skin)),
    layer(names.face, width, height, (p) => ellipse(p, X(256), Y(224), X(104), Y(126), skin)),
  ];
  if (combinedEyes) {
    layers.push(layer(strangeNames ? "眼白" : "eye_white", width, height, (p) => { ellipse(p, X(216), Y(224), X(34), Y(18), white); ellipse(p, X(296), Y(224), X(34), Y(18), white); }));
    layers.push(layer(strangeNames ? "瞳" : "iris", width, height, (p) => { ellipse(p, X(216), Y(225), X(12), Y(16), eye); ellipse(p, X(296), Y(225), X(12), Y(16), eye); }));
    layers.push(layer(strangeNames ? "睫毛" : "eyelash", width, height, (p) => { line(p, X(184), Y(219), X(247), Y(218), X(5), ink); line(p, X(265), Y(218), X(328), Y(219), X(5), ink); }));
    layers.push(layer(strangeNames ? "眉" : "eyebrow", width, height, (p) => { line(p, X(192), Y(190), X(238), Y(187), X(5), ink); line(p, X(274), Y(187), X(320), Y(190), X(5), ink); }));
  } else {
    layers.push(layer(names.whiteR, width, height, (p) => ellipse(p, X(216), Y(224), X(34), Y(18), white)));
    layers.push(layer(names.whiteL, width, height, (p) => ellipse(p, X(296), Y(224), X(34), Y(18), white)));
    layers.push(layer(names.irisR, width, height, (p) => ellipse(p, X(216), Y(225), X(12), Y(16), eye)));
    layers.push(layer(names.irisL, width, height, (p) => ellipse(p, X(296), Y(225), X(12), Y(16), eye)));
    layers.push(layer(names.lashR, width, height, (p) => line(p, X(184), Y(219), X(247), Y(218), X(5), ink)));
    layers.push(layer(names.lashL, width, height, (p) => line(p, X(265), Y(218), X(328), Y(219), X(5), ink)));
    layers.push(layer(names.browR, width, height, (p) => line(p, X(192), Y(190), X(238), Y(187), X(5), ink)));
    layers.push(layer(names.browL, width, height, (p) => line(p, X(274), Y(187), X(320), Y(190), X(5), ink)));
  }
  layers.push(
    layer(names.nose, width, height, (p) => line(p, X(256), Y(242), X(250), Y(261), X(3), [181, 126, 124, 210])),
    layer(names.mouth, width, height, (p) => line(p, X(240), Y(283), X(272), Y(283), X(4), [173, 82, 105, 255])),
    layer(names.front, width, height, (p) => { polygon(p, [[X(157),Y(184)],[X(184),Y(94)],[X(230),Y(102)],[X(220),Y(205)]], hairLight); polygon(p, [[X(210),Y(110)],[X(266),Y(85)],[X(258),Y(207)]], hair); polygon(p, [[X(250),Y(92)],[X(320),Y(105)],[X(290),Y(205)]], hairLight); polygon(p, [[X(301),Y(109)],[X(355),Y(180)],[X(314),Y(208)]], hair); }),
    layer(names.accessory, width, height, (p) => { polygon(p, [[X(338),Y(118)],[X(382),Y(103)],[X(367),Y(143)]], [224, 100, 140, 255]); polygon(p, [[X(338),Y(118)],[X(372),Y(153)],[X(330),Y(144)]], [224, 100, 140, 255]); ellipse(p, X(340), Y(126), X(10), Y(10), [245, 181, 89, 255]); }),
    layer("mystery_charm", width, height, (p) => ellipse(p, X(378), Y(365), X(8), Y(8), [252, 209, 88, 210]))
  );
  let filler = 0;
  while (layers.length < layerCount) {
    layers.push(layer(`accessory_detail_${filler}`, width, height, (p) => ellipse(p, X(150 + (filler % 8) * 28), Y(370 + (filler % 3) * 18), X(5), Y(5), [180, 170, 245, 180])));
    filler += 1;
  }
  return layers;
}

async function writeFixture(name, width, height, children, options = {}) {
  const imageData = composite(width, height, children);
  const psd = { width, height, children, imageData };
  await writeFile(resolve(fixtureDirectory, name), writePsdBuffer(psd, { generateThumbnail: false, trimImageData: false, noBackground: true, compress: true }));
  if (options.reference) {
    await sharp(Buffer.from(imageData.data), { raw: { width, height, channels: 4 } }).png().toFile(resolve(fixtureDirectory, options.reference));
  }
}

const semantic = standardLayers(512, 512);
await writeFixture("semantic.psd", 512, 512, semantic, { reference: "semantic-reference.png" });
await writeFixture("combined-eyes.psd", 512, 512, standardLayers(512, 512, { combinedEyes: true }));
await writeFixture("strange-names.psd", 512, 512, standardLayers(512, 512, { strangeNames: true }));

const groupedSource = standardLayers(512, 512).filter((item) => ["back_hair", "top_wear", "neck", "face", "front_hair", "mystery_charm"].includes(item.name));
await writeFixture("grouped.psd", 512, 512, [{ name: "character", opened: true, children: groupedSource }]);

const minimalImage = composite(512, 512, semantic);
await writeFixture("minimal.psd", 512, 512, [{ name: "complete_character", imageData: minimalImage, blendMode: "normal", opacity: 1 }]);
await writeFixture("missing-face.psd", 512, 512, semantic.filter((item) => item.name !== "face"));
await writeFixture("unknown-noise.psd", 512, 512, [layer("????", 512, 512, (p) => { ellipse(p, 256, 256, 120, 180, [130, 130, 150, 255]); setPixel(p, 4, 4, [255, 255, 255, 12]); })]);
const maskedLayer = layer("face_masked", 128, 128, (p) => ellipse(p, 64, 64, 52, 58, [220, 120, 150, 255]), { opacity: 0.5, blendMode: "multiply" });
const maskImage = pixels(128, 128);
rectangle(maskImage, 0, 0, 64, 128, [255, 255, 255, 255]);
maskedLayer.mask = { top: 0, left: 0, bottom: 128, right: 128, defaultColor: 0, imageData: maskImage };
await writeFixture("mask-group-blend.psd", 128, 128, [{ name: "half opacity group", opacity: 0.5, opened: true, children: [maskedLayer] }]);
await writeFixture("empty.psd", 64, 64, [{ name: "transparent", imageData: pixels(64, 64), blendMode: "normal", opacity: 1 }]);
await writeFile(resolve(fixtureDirectory, "corrupted.psd"), Buffer.from("not a psd\n", "utf8"));
await writeFixture("performance-23.psd", 1280, 1280, standardLayers(1280, 1280, { layerCount: 23 }));

process.stdout.write(`Generated PuppetLoom fixtures in ${fixtureDirectory}\n`);
