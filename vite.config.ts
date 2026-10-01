import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

function youtubeApiPlugin() {
  return {
    name: 'youtube-related-api',
    configureServer(server: any) {
      server.middlewares.use('/api/youtube-related', async (req: any, res: any) => {
        try {
          const parsedUrl = new URL(req.url, 'http://localhost:3000');
          const query = parsedUrl.searchParams.get('q') || 'Hindi Movie';
          const currentId = parsedUrl.searchParams.get('v') || '';

          const fetchYt = async (q: string) => {
            const searchUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
            const ytRes = await fetch(searchUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
              }
            });
            const html = await ytRes.text();
            const match = html.match(/var ytInitialData = ({.*?});<\/script>/s);
            const results: any[] = [];
            if (match) {
              const data = JSON.parse(match[1]);
              const sectionList = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
              for (const section of sectionList) {
                const itemSection = section.itemSectionRenderer?.contents || [];
                for (const item of itemSection) {
                  const v = item.videoRenderer;
                  if (v && v.videoId && v.videoId !== currentId) {
                    results.push({
                      id: v.videoId,
                      videoId: v.videoId,
                      yt: v.videoId,
                      title: v.title?.runs?.map((r: any) => r.text).join('') || v.title?.simpleText || 'YouTube Video',
                      poster: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
                      duration: v.lengthText?.simpleText || 'Full HD',
                      rating: '4.8',
                      category: 'YouTube Video',
                      channel: v.ownerText?.runs?.map((r: any) => r.text).join('') || 'YouTube',
                      views: v.shortViewCountText?.simpleText || ''
                    });
                  }
                }
              }
            }
            return results;
          };

          let videos = await fetchYt(query);
          if (videos.length < 20) {
            const moreVideos = await fetchYt(query + ' Full Movie');
            const seen = new Set(videos.map((v: any) => v.videoId));
            for (const v of moreVideos) {
              if (!seen.has(v.videoId)) {
                seen.add(v.videoId);
                videos.push(v);
              }
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify(videos.slice(0, 25)));
        } catch (err: any) {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message || 'Failed' }));
        }
      });
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    youtubeApiPlugin()
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        music: resolve(__dirname, 'music.html'),
        qr: resolve(__dirname, 'qr.html'),
        share: resolve(__dirname, 'share.html'),
        antSmash: resolve(__dirname, 'ant-smash.html'),
        carRacing: resolve(__dirname, 'car-racing.html'),
        fillTheGap: resolve(__dirname, 'fill-the-gap.html'),
        jewelCrush: resolve(__dirname, 'jewel-crush.html'),
        paymentSuccess: resolve(__dirname, 'payment-success.html')
      }
    }
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true
  }
});
