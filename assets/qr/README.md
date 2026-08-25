# QR code — `/qr`

The printed code encodes **`https://speedyins.com/qr`** and nothing else.
The destination is NOT in the image. It lives in `vercel.json`:

```json
"redirects": [
  { "source": "/qr", "destination": "/quote.html?src=qr", "permanent": false }
]
```

## To repoint the QR
Change `destination` above, commit, done. The printed codes never change.

## Do not set `permanent: true`
`true` emits a 308, which phones cache indefinitely. Anyone who scanned before
the change would keep landing on the old page and you cannot clear their cache.
`false` emits a 307, re-checked on every scan. This one field is the only reason
the code is repointable.

## Keep `?src=qr` on the destination
`quote.html` and `cotizar.html` look for a `src` param starting with `qr`. When
present they rewrite the address bar to the site root, so a refresh goes to the
homepage instead of stranding the visitor on a bare quote form. Drop the param
and that behaviour silently stops.

## Files
- `speedy-qr.svg` — vector, for print (decals, flyers, cards)
- `speedy-qr.png` — 1800px raster, for Canva/social

Version 3, 29 modules, error correction H (30%), navy `#0B1829` on white.
H means the centre can carry the Speedy logo and still scan.
