# Sidetrack

An endless, full-screen feed of new music picked from the music you already love. One song per screen: scroll for the next, like the ones you love, or turn on Auto and let it play in the background.

- **Discovery**: walks from the artists in your imported playlists to the artists Deezer lists as related, never plays artists you already have, and lets you lean toward familiar names or deep cuts.
- **Taste model (on-device)**: a Web Worker computes a 38-number sound profile of each preview (MFCC timbre, brightness, energy, band balance, onset rate, tempo). Songs from your playlists, likes and quick skips train a nearest-neighbour + logistic-regression model that reranks what comes next.
- **Import**: screenshots of a playlist from any app (read on-device with Tesseract.js), Deezer playlist/album links, Exportify CSV, Spotify data-export JSON, M3U/M3U8, XSPF, JSPF, pasted lists (including Apple Music/iTunes copy), or typed artist names.
- **Visualizer**: record grooves around the cover, driven by the song's real spectrum and coloured from the artwork.
- **Data**: candidates are judged from a 160 KB slice of their preview; only songs that reach the screen are downloaded in full, and those bytes are what plays. Data Saver lowers the read-ahead further.

Catalog, artwork and 30-second previews come from the public Deezer API. Everything else lives in `localStorage`.
