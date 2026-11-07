import { AlphaType, ColorType, Skia } from "@shopify/react-native-skia";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import jsQR from "jsqr";

/**
 * The width that a still is reduced to before it is decoded. A QR that fills the scanner's frame is
 * roughly 90 modules across at this width, which is what the decoder needs, and the JPEG is small
 * enough to decode on the JS thread without a visible pause.
 */
const DECODE_WIDTH = 1024;

/**
 * The text of the first QR code in the photo at `uri`, or null when it holds none.
 *
 * The fork decodes here instead of in the camera module: `expo-camera` reads QR codes with Google's
 * ML Kit, which would put `com.google.mlkit:barcode-scanning` and its model files into the APK.
 * `scripts/fork/…` keeps ML Kit out (`expo.camera.barcode-scanner-enabled=false`), so the scanner
 * takes a still picture and decodes it with `jsqr`, which is plain JavaScript over the pixels that
 * Skia reads. `qr-scanner.tsx` calls this in a loop while the preview is live.
 */
export async function decodeQrCode(uri: string): Promise<string | null> {
  const rendered = await ImageManipulator.manipulate(uri).resize({ width: DECODE_WIDTH }).renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
  const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(await new File(saved.uri).bytes()));
  if (!image) return null;
  const width = image.width();
  const height = image.height();
  const pixels = image.readPixels(0, 0, {
    width,
    height,
    colorType: ColorType.RGBA_8888,
    alphaType: AlphaType.Unpremul,
  });
  if (!pixels) return null;
  // `jsqr` wants clamped bytes; Skia hands out a plain `Uint8Array` of the same layout.
  const found = jsQR(new Uint8ClampedArray(pixels), width, height, { inversionAttempts: "attemptBoth" });
  return found?.data ?? null;
}
