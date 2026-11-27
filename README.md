# Liner

Music discovery with a social layer, as a static site.

- **For you**: digs from the artists in your imported playlists to the artists Deezer lists as related, scores the ones several of your artists lead to, skips anything you already have, and plays a 30-second preview of each. A dial shifts between familiar names and deep cuts.
- **Import**: CSV (Exportify, TuneMyMusic), Spotify account-data JSON, M3U/M3U8, XSPF, JSPF, plain text, or a public Deezer playlist/album link.
- **Social**: posts, reposts, profiles, taste match and following. There are no servers: your profile travels as a compressed link, and following someone stores a snapshot of it. Followed people can be blended into your For you feed. Genre channels post four picks a day.

Catalog, artwork and previews come from the public Deezer API via JSONP. Everything else lives in `localStorage`.
