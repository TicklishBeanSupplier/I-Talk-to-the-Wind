// Procedural sample pictures for preview mode: bluebird days and skate spots.
// Small SVGs as data URLs, so the preview needs no image files.

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function tree(x: number, y: number, h: number, r: () => number): string {
  const blobs: string[] = [];
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const w = h * (0.32 - t * 0.22);
    blobs.push(
      `<ellipse cx="${x + (r() - 0.5) * 6}" cy="${y - h * t}" rx="${w}" ry="${h * 0.13}" fill="#F7FAFE"/>`,
      `<ellipse cx="${x + w * 0.35}" cy="${y - h * t + 5}" rx="${w * 0.6}" ry="${h * 0.06}" fill="#C9D8EE" opacity=".7"/>`,
    );
  }
  return blobs.join("");
}

export function snowArt(seed: number, w = 800, h = 1000): string {
  const r = rng(seed);
  const slopeY = h * (0.45 + r() * 0.15);
  const trees: string[] = [];
  for (let i = 0; i < 7; i++) trees.push(tree(r() * w, slopeY + r() * h * 0.5, h * (0.18 + r() * 0.3), r));
  const riderX = w * (0.35 + r() * 0.3);
  const riderY = slopeY + h * 0.08;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1747B0"/><stop offset="1" stop-color="#4F8BE8"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#s)"/>
<ellipse cx="${w * r()}" cy="${h * 0.15}" rx="${w * 0.25}" ry="${h * 0.05}" fill="#fff" opacity=".85"/>
<ellipse cx="${w * r()}" cy="${h * 0.28}" rx="${w * 0.18}" ry="${h * 0.04}" fill="#fff" opacity=".7"/>
<path d="M0 ${slopeY + h * 0.2} Q ${w * 0.5} ${slopeY - h * 0.1} ${w} ${slopeY} V ${h} H 0 Z" fill="#F3F7FC"/>
<path d="M0 ${slopeY + h * 0.35} Q ${w * 0.6} ${slopeY + h * 0.1} ${w} ${slopeY + h * 0.25} V ${h} H 0 Z" fill="#DCE6F4"/>
${trees.join("")}
<ellipse cx="${riderX + 30}" cy="${riderY + 10}" rx="60" ry="22" fill="#fff" opacity=".9"/>
<rect x="${riderX - 8}" y="${riderY - 46}" width="18" height="34" rx="6" fill="#1E2A4A"/>
<circle cx="${riderX + 1}" cy="${riderY - 54}" r="9" fill="#F5B82E"/>
<rect x="${riderX - 26}" y="${riderY - 10}" width="56" height="7" rx="3" fill="#B6F03C" transform="rotate(-18 ${riderX} ${riderY})"/>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function skateArt(seed: number, w = 800, h = 1000): string {
  const r = rng(seed);
  const ground = h * (0.62 + r() * 0.1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">
<rect width="${w}" height="${h}" fill="#F4A259"/>
<circle cx="${w * (0.2 + r() * 0.6)}" cy="${h * 0.3}" r="${w * 0.14}" fill="#FFD23F"/>
<rect y="${ground}" width="${w}" height="${h - ground}" fill="#B9B4AD"/>
<path d="M${w * 0.1} ${ground} Q ${w * 0.3} ${ground - h * 0.25} ${w * 0.55} ${ground}" fill="#D7D2CA"/>
<rect x="${w * 0.6}" y="${ground - 40}" width="${w * 0.3}" height="10" fill="#555"/>
<rect x="${w * 0.42}" y="${ground - h * 0.2}" width="18" height="40" rx="6" fill="#1E2A4A"/>
<circle cx="${w * 0.42 + 9}" cy="${ground - h * 0.2 - 10}" r="9" fill="#C42A63"/>
<rect x="${w * 0.42 - 22}" y="${ground - h * 0.2 + 46}" width="62" height="7" rx="3" fill="#222"/>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
