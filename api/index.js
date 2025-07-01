// api/index.js

/**
 * Función auxiliar para crear una respuesta de error JSON con encabezados CORS.
 * @param {string} message El mensaje de error.
 * @param {number} status El código de estado HTTP.
 * @param {string} mediaFireLink El enlace de MediaFire que causó el error.
 * @returns {Response}
 */
function createErrorResponse(message, status, mediaFireLink) {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  // Encabezados CORS para permitir que cualquier frontend acceda a esta API.
  // Es importante que estos encabezados estén presentes en todas las respuestas.
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type'); // Si tu frontend envía algún encabezado específico
  headers.set('Access-Control-Max-Age', '86400'); // Cachea las opciones CORS por 24 horas

  return new Response(JSON.stringify({
    error: message,
    link_provided: mediaFireLink || 'N/A'
  }), {
    status: status,
    headers: headers
  });
}

/**
 * Función principal para manejar las solicitudes entrantes.
 * @param {Request} request La solicitud HTTP entrante.
 */
export default {
  async fetch(request) {
    // Manejar solicitudes OPTIONS (preflight) para CORS
    if (request.method === 'OPTIONS') {
      const headers = new Headers();
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      headers.set('Access-Control-Max-Age', '86400');
      return new Response(null, { status: 204, headers: headers }); // 204 No Content para preflight
    }

    const url = new URL(request.url);
    const mediaFireLink = url.searchParams.get('require');

    // 1. Validar que el parámetro 'require' existe
    if (!mediaFireLink) {
      return createErrorResponse(
        "Falta el parámetro 'require'. Por favor, proporciona un enlace de MediaFire.",
        400,
        null
      );
    }

    // 2. Validar que es una URL válida de MediaFire
    if (!mediaFireLink.startsWith('http://www.mediafire.com/') && !mediaFireLink.startsWith('https://www.mediafire.com/')) {
      return createErrorResponse(
        "Enlace de MediaFire inválido. Debe comenzar con http(s)://www.mediafire.com/",
        400,
        mediaFireLink
      );
    }

    let directDownloadUrl = null;

    try {
      // 3. Obtener la página de MediaFire para extraer el enlace directo
      const mediafirePageResponse = await fetch(mediaFireLink, {
        headers: {
          // Usar un User-Agent de navegador para evitar ser bloqueado
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        }
      });

      if (!mediafirePageResponse.ok) {
        return createErrorResponse(
          `Error al obtener la página de MediaFire: ${mediafirePageResponse.status} ${mediafirePageResponse.statusText}`,
          mediafirePageResponse.status,
          mediaFireLink
        );
      }

      const htmlContent = await mediafirePageResponse.text();

      // 4. Extraer el enlace directo del HTML (orden de prioridad)
      // Regex 1: Busca 'a' tag con id="download-button" y extrae su href.
      const downloadLinkRegex1 = /<a[^>]*id="download-button"[^>]*href="([^"]+)"/i;
      let match = htmlContent.match(downloadLinkRegex1);

      if (match && match[1]) {
        directDownloadUrl = match[1];
      } else {
        // Regex 2: Busca 'var download_url = "..."' en JS
        const jsDownloadLinkRegex2 = /var\s+download_url\s*=\s*"(https?:\/\/[^"]+)";/i;
        match = htmlContent.match(jsDownloadLinkRegex2);
        if (match && match[1]) {
          directDownloadUrl = match[1];
        } else {
          // Regex 3: Busca 'window.dl_link = "..."' en JS
          const dlLinkRegex3 = /window\.dl_link\s*=\s*"(https?:\/\/[^"]+)";/i;
          match = htmlContent.match(dlLinkRegex3);
          if (match && match[1]) {
            directDownloadUrl = match[1];
          } else {
            // Regex 4: Otra posible forma, aunque menos común ahora: busca un enlace directo dentro de un script
            const directLinkInScriptRegex = /<script[^>]*>[\s\S]*?(https?:\/\/[^\s"'<>;]+\.(?:zip|rar|7z|exe|mp4|mp3|pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|txt|iso|apk|dmg|deb|rpm|tar\.gz|gz|bz2|xz))[\s\S]*?<\/script>/i;
            match = htmlContent.match(directLinkInScriptRegex);
            if (match && match[1]) {
              directDownloadUrl = match[1];
            }
          }
        }
      }

      if (!directDownloadUrl) {
        return createErrorResponse(
          "No se pudo encontrar el enlace de descarga directo en la página de MediaFire. La estructura de la página podría haber cambiado.",
          500,
          mediaFireLink
        );
      }

      // 5. Descargar y transmitir el archivo
      const fileResponse = await fetch(directDownloadUrl, {
        headers: {
          // Reenviar el User-Agent original o usar uno genérico para la descarga
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (Cloudflare Worker Download Proxy)'
        },
        redirect: 'follow' // Seguir redirecciones si el enlace directo hace una (común)
      });

      if (!fileResponse.ok) {
        return createErrorResponse(
          `Error al descargar el archivo del enlace directo: ${fileResponse.status} ${fileResponse.statusText}`,
          fileResponse.status,
          mediaFireLink
        );
      }

      // 6. Preparar encabezados para la respuesta al cliente
      const headers = new Headers();

      // Añadir encabezados CORS a la respuesta exitosa también
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      headers.set('Access-Control-Max-Age', '86400');

      // Reenviar el Content-Type original o establecer uno por defecto
      headers.set('Content-Type', fileResponse.headers.get('Content-Type') || 'application/octet-stream');

      // Reenviar el Content-Length si está disponible (útil para progreso de descarga)
      if (fileResponse.headers.has('Content-Length')) {
        headers.set('Content-Length', fileResponse.headers.get('Content-Length'));
      }

      // Determinar el nombre del archivo para Content-Disposition
      let filename = 'downloaded_file';
      const contentDispositionHeader = fileResponse.headers.get('Content-Disposition');

      if (contentDispositionHeader) {
        // Extraer nombre de archivo si está presente en Content-Disposition del archivo original
        const filenameMatch = /filename\*?=['"]?(?:UTF-8'')?([^;"]+)/i.exec(contentDispositionHeader);
        if (filenameMatch && filenameMatch[1]) {
          filename = decodeURIComponent(filenameMatch[1]);
        }
      }

      if (filename === 'downloaded_file') {
        // Fallback: Intentar obtener el nombre del archivo de la URL original de MediaFire
        try {
          const originalUrl = new URL(mediaFireLink);
          const segments = originalUrl.pathname.split('/');
          const lastSegment = segments[segments.length - 2]; // MediaFire URLs suelen tener /file/HASH/NOMBRE/file
          if (lastSegment && lastSegment !== 'file') { // Asegurarse de que no sea solo 'file'
            filename = decodeURIComponent(lastSegment.replace(/\+/g, ' ')); // Decodificar y manejar espacios
          } else {
            // Último recurso: usar el hash de la URL si no se encuentra un nombre claro
            const hashMatch = originalUrl.pathname.match(/\/file\/([a-zA-Z0-9]+)\//);
            if (hashMatch && hashMatch[1]) {
                filename = `mediafire_file_${hashMatch[1]}`;
            }
          }
        } catch (e) {
          // Ignorar errores de URL parsing y mantener el nombre por defecto
        }

        // Asegurarse de que el nombre de archivo tenga una extensión si se puede inferir del Content-Type
        if (!filename.includes('.') && headers.get('Content-Type')) {
          const mime = headers.get('Content-Type').split(';')[0];
          const extMap = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
            'application/pdf': 'pdf', 'application/zip': 'zip',
            'application/vnd.rar': 'rar', 'application/x-7z-compressed': '7z',
            'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
            'application/msword': 'doc',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
            'application/vnd.ms-excel': 'xls',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
            'application/vnd.ms-powerpoint': 'ppt',
            'application/x-bittorrent': 'torrent',
            'application/x-iso9660-image': 'iso',
            'application/vnd.android.package-archive': 'apk',
            'text/plain': 'txt'
            // Añade más mapeos de MIME a extensión si es necesario
          };
          const ext = extMap[mime] || mime.split('/')[1]; // Usa el mapeo, o la parte después de '/'
          if (ext && !filename.includes(ext)) { // Evitar doble extensión si ya está
            filename += `.${ext}`;
          }
        }
      }

      // Forzar la descarga con un nombre de archivo sugerido
      headers.set('Content-Disposition', `attachment; filename="${filename}"`);

      // Eliminar encabezados que podrían causar problemas o no son relevantes del origen
      headers.delete('set-cookie');
      headers.delete('cf-ray');
      headers.delete('alt-svc');
      headers.delete('vary');
      headers.delete('etag');
      headers.delete('content-encoding'); // Cloudflare Workers manejan esto automáticamente
      headers.delete('accept-ranges'); // Evitar problemas si el worker no lo soporta

      return new Response(fileResponse.body, { status: fileResponse.status, headers: headers });

    } catch (error) {
      console.error('Error general en el Worker:', error); // Log para depuración en Cloudflare
      return createErrorResponse(
        `Error interno del servidor al procesar la solicitud: ${error.message}`,
        500,
        mediaFireLink
      );
    }
  },
};
