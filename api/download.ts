import crypto from 'crypto';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface J2MediaItem {
  quality: string;
  label: string;
  url: string;
  extension: string;
  type: 'video' | 'audio';
}

export interface J2DownloadResult {
  status: boolean;
  message?: string;
  videoId?: string;
  title?: string;
  author?: string;
  duration?: string;
  thumbnail?: string;
  viewCount?: string;
  medias?: J2MediaItem[];
}

function hasLeadingZeroNibbles(
  bytes: Buffer | Uint8Array,
  difficulty: number
): boolean {
  const fullBytes = Math.floor(difficulty / 2);
  const hasHalfByte = difficulty % 2 === 1;

  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== 0) {
      return false;
    }
  }

  if (
    hasHalfByte &&
    ((bytes[fullBytes] ?? 0) & 0xf0) !== 0
  ) {
    return false;
  }

  return true;
}

function solvePow(
  challenge: string,
  nonce: string,
  difficulty: number,
  challengeType: string = 'classic'
): string | null {
  const prefix =
    challengeType === 'alt'
      ? `pow:${nonce}:`
      : `pow:${challenge}:`;

  const suffix =
    challengeType === 'alt'
      ? `:${challenge}`
      : `:${nonce}:${challenge.length}`;

  for (let n = 0; n < 10_000_000; n++) {
    const str = `${prefix}${n}${suffix}`;

    const hash = crypto
      .createHash('sha256')
      .update(str)
      .digest();

    if (hasLeadingZeroNibbles(hash, difficulty)) {
      return String(n);
    }
  }

  return null;
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function scrapeJ2Download(
  youtubeUrl: string
): Promise<J2DownloadResult> {
  const baseHeaders = {
    'User-Agent': UA,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: 'https://j2download.com/',
    Origin: 'https://j2download.com',
  };

  try {
    /*
     * STEP 1
     * Ambil halaman utama J2Download
     */
    const homeRes = await fetch('https://j2download.com', {
      method: 'GET',
      headers: baseHeaders,
      signal: timeoutSignal(15_000),
    });

    if (!homeRes.ok) {
      throw new Error(
        `J2Download homepage HTTP ${homeRes.status}`
      );
    }

    /*
     * Ambil cookie
     */
    const setCookie = homeRes.headers.get('set-cookie') || '';

    const cookie = setCookie
      .split(';')[0]
      .trim();

    /*
     * Ambil HTML
     */
    const html = await homeRes.text();

    /*
     * STEP 2
     * Extract __BOOTSTRAP__
     */
    const match = html.match(
      /window\.__BOOTSTRAP__\s*=\s*(\{.*?\});/
    );

    if (!match) {
      throw new Error(
        'Gagal mengekstrak __BOOTSTRAP__ dari j2download.com'
      );
    }

    let bootstrap: any;

    try {
      bootstrap = JSON.parse(match[1]);
    } catch {
      throw new Error(
        'Data __BOOTSTRAP__ dari J2Download tidak valid'
      );
    }

    if (!bootstrap?.nonce) {
      throw new Error(
        'Nonce J2Download tidak ditemukan'
      );
    }

    if (!bootstrap?.powChallenge) {
      throw new Error(
        'POW challenge J2Download tidak ditemukan'
      );
    }

    /*
     * STEP 3
     * Solve Proof-of-Work
     */
    const difficulty = Number(
      bootstrap.powDifficulty || 3
    );

    const solution = solvePow(
      bootstrap.powChallenge,
      bootstrap.nonce,
      difficulty,
      bootstrap.challengeType || 'classic'
    );

    if (!solution) {
      throw new Error(
        'Gagal menemukan solusi Proof-of-Work'
      );
    }

    /*
     * STEP 4
     * Request Access Token
     */
    const authRes = await fetch(
      'https://j2download.com/api/auth/issue',
      {
        method: 'POST',

        headers: {
          'User-Agent': UA,
          Referer: 'https://j2download.com/',
          Origin: 'https://j2download.com',
          Cookie: cookie,
          'X-Page-Nonce': bootstrap.nonce,
          'X-Pow-Solution': solution,
          Accept:
            'application/json, text/plain, */*',
        },

        signal: timeoutSignal(15_000),
      }
    );

    let authData: any;

    try {
      authData = await authRes.json();
    } catch {
      throw new Error(
        `Response auth J2Download bukan JSON (HTTP ${authRes.status})`
      );
    }

    if (!authRes.ok) {
      throw new Error(
        authData?.message ||
          `Auth J2Download HTTP ${authRes.status}`
      );
    }

    const token = authData?.accessToken;

    if (!token) {
      throw new Error(
        authData?.message ||
          'Access Token tidak ditemukan'
      );
    }

    /*
     * STEP 5
     * Request download information
     */
    const autoRes = await fetch(
      'https://j2download.com/api/autolink',
      {
        method: 'POST',

        headers: {
          'User-Agent': UA,
          Referer: 'https://j2download.com/',
          Origin: 'https://j2download.com',
          Cookie: cookie,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept:
            'application/json, text/plain, */*',
        },

        body: JSON.stringify({
          data: {
            url: youtubeUrl,
            unlock: true,
          },
        }),

        signal: timeoutSignal(30_000),
      }
    );

    let result: any;

    try {
      result = await autoRes.json();
    } catch {
      throw new Error(
        `Response autolink bukan JSON (HTTP ${autoRes.status})`
      );
    }

    if (!autoRes.ok) {
      throw new Error(
        result?.message ||
          `J2Download HTTP ${autoRes.status}`
      );
    }

    if (result?.error) {
      return {
        status: false,
        message:
          result.message ||
          'Server J2Download mengembalikan error.',
      };
    }

    /*
     * STEP 6
     * Return result
     */
    return {
      status: true,
      videoId: result.videoId,
      title: result.title,
      author: result.author,
      duration:
        result.duration ||
        result.lengthSeconds,
      thumbnail: result.thumbnail,
      viewCount: result.viewCount,
      medias: result.medias,
    };
  } catch (error: any) {
    console.error(
      '[J2Download Error]',
      error
    );

    return {
      status: false,
      message:
        error?.name === 'TimeoutError'
          ? 'Request ke J2Download timeout.'
          : error?.message ||
            'Terjadi kesalahan saat memproses request.',
    };
  }
}

/*
 * VERCEL API HANDLER
 */
export default async function handler(
  req: Request
): Promise<Response> {
  /*
   * CORS
   */
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':
      'GET, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type',
  };

  /*
   * OPTIONS / CORS preflight
   */
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  /*
   * Hanya GET
   */
  if (req.method !== 'GET') {
    return Response.json(
      {
        status: false,
        message: 'Method tidak diizinkan. Gunakan GET.',
      },
      {
        status: 405,
        headers: corsHeaders,
      }
    );
  }

  /*
   * Ambil ?url=
   */
  const { searchParams } =
    new URL(req.url);

  const youtubeUrl =
    searchParams.get('url')?.trim();

  /*
   * Validasi URL
   */
  if (!youtubeUrl) {
    return Response.json(
      {
        status: false,
        message:
          'Parameter "url" wajib diisi.',
        example:
          '/api/download?url=https://youtube.com/watch?v=xxxxx',
      },
      {
        status: 400,
        headers: corsHeaders,
      }
    );
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(youtubeUrl);
  } catch {
    return Response.json(
      {
        status: false,
        message: 'URL tidak valid.',
      },
      {
        status: 400,
        headers: corsHeaders,
      }
    );
  }

  /*
   * Validasi domain YouTube
   */
  const allowedHosts = [
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be',
    'www.youtu.be',
  ];

  if (!allowedHosts.includes(parsedUrl.hostname)) {
    return Response.json(
      {
        status: false,
        message:
          'URL harus berasal dari YouTube.',
      },
      {
        status: 400,
        headers: corsHeaders,
      }
    );
  }

  /*
   * Jalankan scraper
   */
  const result =
    await scrapeJ2Download(youtubeUrl);

  /*
   * HTTP status
   */
  const statusCode =
    result.status ? 200 : 502;

  return Response.json(
    result,
    {
      status: statusCode,
      headers: {
        ...corsHeaders,
        'Cache-Control':
          'no-store, max-age=0',
      },
    }
  );
          }
