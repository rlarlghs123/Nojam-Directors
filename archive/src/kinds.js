// What kind of block a file becomes, decided by its extension.

const groups = {
  image: 'jpg jpeg jpe jfif png apng gif webp avif heic heif hif tif tiff bmp ico svg jxl psd psb tga exr hdr ' +
    'dng cr2 cr3 nef nrw arw raf orf rw2 pef srw x3f',
  video: 'mp4 m4v mov webm mkv avi wmv flv mpg mpeg 3gp ogv mts m2ts',
  audio: 'mp3 m4a aac wav aif aiff flac ogg oga opus',
  text: 'txt text md markdown mdown mkd rtf html htm xhtml docx odt hwp hwpx doc fountain srt vtt org rst adoc tex ' +
    'csv tsv json yaml yml xml log js mjs ts css py rb go rs java swift kt c h cpp sh',
  pdf: 'pdf ai',
  link: 'url webloc desktop gdoc gsheet gslides gdraw gform gmap',
  font: 'ttf otf woff woff2',
  // Design files that carry an embedded preview image.
  design: 'pages key numbers sketch fig xd indd pptx epub afdesign afphoto afpub eps',
};

const KIND = new Map();
for (const [kind, list] of Object.entries(groups)) {
  for (const ext of list.split(/\s+/)) KIND.set(ext, kind);
}

export function kindOf(ext) {
  return KIND.get(ext) || 'file';
}

// Images the browser can show directly. Everything else gets a JPEG preview.
export const WEB_IMAGES = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico']);
export const HEIC = new Set(['heic', 'heif', 'hif']);
export const RAW = new Set(['dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'raf', 'orf', 'rw2', 'pef', 'srw', 'x3f']);
export const MARKDOWN = new Set(['md', 'markdown', 'mdown', 'mkd']);
// Plain text files the memo editor may rewrite in place.
export const EDITABLE = new Set(['txt', 'text', 'md', 'markdown', 'mdown', 'mkd', 'fountain']);
