# Local test media

`vinyl-test.mp4` is a synthetic 1.2-second color image and sine tone, not a file from a third-party service. It is used only in the Windows installer smoke test, never packaged into the app. SHA‑256: `d3c35bb793efaed7d75a0675ba8eb18ebb0d5b15b44419d01a48c109741049f4`.

The 854×480 H.264/AAC fixture was generated using the repository's FFmpeg build:

```sh
ffmpeg -f lavfi -i 'color=c=0x292019:s=854x480:r=24:d=1.2' \
  -f lavfi -i 'sine=frequency=392:sample_rate=44100:duration=1.2' \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 48k -movflags +faststart \
  -map_metadata -1 -shortest vinyl-test.mp4
```
