# Sidetrack

An endless, full-screen feed of new music. One song per screen: scroll for the next, like the ones you love, or turn on Auto and let it play in the background.

- **No playlist needed**: press Start and the feed begins from what's charting on Deezer, across a random mix of genres, then leans toward whatever you like.
- **Playlist links from any site**: paste a public link from Spotify, Apple Music, YouTube, YouTube Music, Deezer, Tidal or SoundCloud. Pages are read through the free reader r.jina.ai (api.microlink.io as backup); sites without a dedicated parser fall back to structured page data, then track-row layout, then page text checked against Deezer. Files (Exportify CSV, Spotify data export, M3U, XSPF, JSPF, TXT) and pasted lists work too.
- **Ranking**: related-artist graph from your music, weighted toward well-known artists and their most popular songs (the Familiar/Deep cuts dial shifts this), with variety rules so no single artist of yours or one sound dominates. Kids' content, audiobooks and off-season holiday songs are skipped.
- **Taste model (on-device)**: a Web Worker computes a 38-number sound profile of each preview (timbre, brightness, energy, band balance, onset rate, tempo). Likes, quick skips and songs from your playlists train a small nearest-neighbour + logistic-regression model.
- **Visualizer**: record grooves around the cover, driven by the song's real spectrum and coloured from the artwork.
- **Data**: candidates are judged from a 160 KB slice of their preview; only songs that reach the screen are downloaded in full, and those bytes are what plays.

Catalog, artwork and 30-second previews come from the public Deezer API. Your playlists, likes and model live in `localStorage`.
