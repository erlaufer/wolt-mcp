# Demo source

Generates `docs/wolt-mcp-demo.gif` — a scripted mock of a wolt-mcp session
(`demo.html` is a deterministic timeline; no real account or footage involved).

Re-render:

```bash
npm install
npx playwright-core install chromium   # once, if no Playwright Chromium is cached
node render.mjs                        # writes frames/*.png (add --preview for spot frames)
ffmpeg -y -framerate 15 -i frames/f%04d.png -vf "fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" ../wolt-mcp-demo.gif
```

For a social-media MP4 (crisper than GIF; upload natively to X/LinkedIn):

```bash
ffmpeg -y -framerate 15 -i frames/f%04d.png -vf "scale=1080:1080:flags=lanczos" -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart wolt-mcp-demo.mp4
```
