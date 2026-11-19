import { expect, test } from "vitest";
import type { VideoFormat } from "@/types";
import {
  armVinylSelection,
  clipboardVideo,
  consumeVinylSelection,
  formatForTier,
  nativeTier,
} from "@/utils/vinylSelection";

const id = "dQw4w9WgXcQ";

test.each([
  `https://www.youtube.com/watch?v=${id}`,
  `https://m.youtube.com/watch?list=PL123&v=${id}`,
  `https://youtu.be/${id}?t=30`,
  `https://youtube.com/shorts/${id}/`,
])("recognizes a single supported clipboard URL without rewriting it: %s", (url) => {
  expect(clipboardVideo(` \n${url}\t `)).toEqual({ id, url });
});

test.each([
  `https://youtube.com.attacker.test/watch?v=${id}`,
  `https://youtube.com@attacker.test/watch?v=${id}`,
  `https://attacker.test/?url=https://youtu.be/${id}`,
  `https://attacker.test@youtube.com/watch?v=${id}`,
  `https://youtu.be:9876/${id}`,
  `https://youtu.be/${id}/extra`,
  `https://youtube.com/watch?v=${id}&v=aZBV8DcT3sE`,
  `http://youtube.com/watch?v=short`,
  `ftp://youtu.be/${id}`,
  `https://www.youtube.com/playlist?list=${id}`,
  `https://youtu.be/${id}\nhttps://youtu.be/aZBV8DcT3sE`,
  `Look at https://youtu.be/${id}`,
])("does not auto-inspect %s", (url) => {
  expect(clipboardVideo(url)).toBeNull();
});

const format = (
  format_id: string,
  width: number,
  height: number,
  vcodec = "avc1.64002A",
): VideoFormat => ({
  format_id,
  width,
  height,
  vcodec,
  ext: "mp4",
  acodec: "none",
  fps: 30,
  resolution: `${width}x${height}`,
  format_note: "",
  filesize: null,
  filesize_approx: null,
  tbr: null,
  abr: null,
});

test("maps portrait video by short edge and never converts or rounds to a marketed tier", () => {
  expect(nativeTier(format("portrait", 1080, 1920))).toBe(1080);
  expect(nativeTier(format("landscape", 1920, 1080))).toBe(1080);
  expect(nativeTier(format("cinema", 1920, 800))).toBe(800);
  expect(nativeTier(format("audio", 1080, 1920, "none"))).toBeNull();
  expect(
    formatForTier([format("a", 1920, 800), format("b", 2560, 1440)], 1080, "b", "avc1"),
  ).toBeUndefined();
});

test("retains a selected real format, then the chosen codec, then upstream order", () => {
  const formats = [
    format("v-av1", 1920, 1080, "av01.0.08M.08"),
    format("v-h264", 1920, 1080),
    format("v-720", 1280, 720),
  ];
  expect(formatForTier(formats, 1080, "v-h264", "all")?.format_id).toBe("v-h264");
  expect(formatForTier(formats, 1080, "v-720", "h264")?.format_id).toBe("v-h264");
  expect(formatForTier(formats, 1080, "v-720", "all")?.format_id).toBe("v-av1");
});

test("only the newly inspected pending tab receives the default", () => {
  armVinylSelection("some-item");
  expect(consumeVinylSelection("other-item")).toBe(false);
  expect(consumeVinylSelection("some-item")).toBe(false);
  armVinylSelection("new-item");
  expect(consumeVinylSelection("new-item")).toBe(true);
  expect(consumeVinylSelection("new-item")).toBe(false);
});
