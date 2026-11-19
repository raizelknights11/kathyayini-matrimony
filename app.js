// =====================================================================
// CONFIG
// =====================================================================

// URL of the deployed Google Apps Script web app (Code.gs → Deploy → Web app)
const API_URL = 'https://script.google.com/macros/s/AKfycbyaLUnvAz2ZXbaNW_DrszAtvmTNBvtXOkoUW0evmXQFbfKcevgbybeLyU3n0MzctPnt/exec';

// Registration form shown to people whose email isn't registered yet
const REGISTER_URL = 'https://forms.gle/b58ddrykTDXBe1LNA';

// Used ONLY for the admin's "guest view" preview toggle. Real access control
// happens on the server — non-admin users never receive these fields.
const HIDDEN_FOR_GUEST = [
  'Phone Number',
  'Address',
  'Email Address',
  'First contact',
  'Second contact',
];

// =====================================================================

let allProfiles  = [];
let filtered     = [];
let activeFilter = 'all';
let currentRole  = null;  // null = not logged in | 'admin' | 'member'
let sessionToken = null;
let sessionEmail = null;
let cardFields   = ["Date Of Birth", "Education", "Work Field", "Staying In", "Gothra"]; // chosen in Settings
let statusFields = ["Date Of Birth", "Nakshatra", "Gothra", "Education", "Staying In"]; // for the Status image
let myProfiles   = [];   // the signed-in member's own profile(s), sent by the server
let _previewGuest = false;

// =====================================================================
// IMAGE & HOROSCOPE — Drive-only, no local probing
// =====================================================================

// Extract a Google Drive file ID from any Drive URL format
function driveFileId(url) {
  if (!url) return null;
  const m1 = url.match(/\/d\/([^\/\?&]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]id=([^&]+)/);
  if (m2) return m2[1];
  return null;
}

// Thumbnail URL — used for displaying photos in cards/lightbox
function driveThumbUrl(url, size = 'w600') {
  const id = driveFileId(url);
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=${size}` : null;
}

// Direct download URL — used for opening horoscopes
function driveDirectUrl(url) {
  const id = driveFileId(url);
  return id ? `https://drive.google.com/file/d/${id}/view` : null;
}

// ── Horoscope cache — never re-fetches the same UID ──────────────────
// Stores: null (not checked) | false (no horoscope) | string URL
const _horoCache = {};

function getHoroscopeUrl(p) {
  // Horoscope is a Drive URL stored directly in the CSV column
  return driveDirectUrl(p['Horoscope'] || '') || null;
}

function buildImg(driveUrl, symbol) {
  const thumb = driveThumbUrl(driveUrl);
  if (!thumb) {
    return `<div class="img-placeholder">${symbol}</div>`;
  }
  return `<img
    src="${thumb}"
    onerror="this.parentElement.innerHTML='<div class=\\'img-placeholder\\'>${symbol}</div>'"
    onload="this.closest('.image-slide').classList.remove('img-loading')"
    onclick="openLightbox(this)"
    style="width:100%;height:100%;object-fit:contain;display:block;cursor:zoom-in;"
    alt="Profile photo"
  >`;
}

// =====================================================================
// CSV PARSER
// =====================================================================

function parseCSV(text) {
  const lines   = text.split('\n');
  const headers = parseCSVLine(lines[0]);
  const rows    = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const obj  = {};
    headers.forEach((h, idx) => { obj[h.trim()] = (vals[idx] || '').trim(); });
    if (obj['Unique ID']) rows.push(obj);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur); cur = '';
    } else { cur += ch; }
  }
  result.push(cur);
  return result;
}

// =====================================================================
// UTILITIES
// =====================================================================

// Returns a Date from a DOB string, or null.
// Handles: "1998", "15/08/1998", "1998-08-15", "08/15/1998",
// "15 Aug 1998", "August 15, 1998", "15-Aug-1998", etc.
function parseDOB(dob) {
  if (!dob) return null;
  const t = dob.trim();

  if (/^\d{4}$/.test(t)) return new Date(parseInt(t), 0, 1);

  // Contains a textual month name — let Date parse it directly
  // (handles "15 Aug 1998", "August 15, 1998", "15-Aug-1998", "Aug 15 1998")
  if (/[A-Za-z]{3,}/.test(t)) {
    const d = new Date(t.replace(/-/g, ' '));
    return isNaN(d) ? null : d;
  }

  const parts = t.split(/[\/\-\s]/);
  let d;
  if (parts.length === 3) {
    const n = parts.map(Number);
    if      (n[2] > 1900) d = null;
    else if (n[0] > 1900) d = new Date(n[0], n[1] - 1, n[2]);
    else                  d = new Date(n[2], n[1] - 1, n[0]);
    // a/b/YYYY: day first (India). Month first only when the second number can't be a month.
    if (n[2] > 1900) d = n[1] > 12 ? new Date(n[2], n[0] - 1, n[1]) : new Date(n[2], n[1] - 1, n[0]);
  } else { d = new Date(t); }
  return isNaN(d) ? null : d;
}

function getAge(dob) {
  const d = parseDOB(dob);
  if (!d) return '—';
  const age = Math.floor((Date.now() - d) / (365.25 * 24 * 60 * 60 * 1000));
  return age > 0 && age < 120 ? age + ' yrs' : '—';
}

// Always display DOB as DD/MM/YYYY, converting textual months ("15 Aug 1998") too
function formatDOB(dob) {
  const d = parseDOB(dob);
  if (!d) return dob || '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// =====================================================================
// CARD RENDERER
// =====================================================================

// Card DOM nodes are cached by UID so re-sorting never rebuilds them
const _cardCache = {};

function getOrCreateCard(p) {
  const uid = p['Unique ID'].trim();
  if (_cardCache[uid]) return _cardCache[uid];

  const isBride = p['Filling the Form Of'] === 'Bride';
  const type    = isBride ? 'bride' : 'groom';
  const cardId  = 'card-' + uid.replace(/[^a-z0-9]/gi, '');
  const age     = getAge(p['Date Of Birth']);
  const symbol  = isBride ? '♀' : '♂';

  const effRole    = (_previewGuest && currentRole === 'admin') ? 'guest' : currentRole;
  // Guests simply don't see the contact section — no notice, no clutter
  const contactHtml = effRole === 'admin'
    ? `<div class="detail-section">
        <div class="section-label">Contact</div>
        <div class="detail-grid">
          <div class="detail-item"><div class="detail-key">Phone</div><div class="detail-val">${p['Phone Number'] || '—'}</div></div>
          <div class="detail-item"><div class="detail-key">Email</div><div class="detail-val" style="word-break:break-all">${p['Email Address'] || '—'}</div></div>
          <div class="detail-item" style="grid-column:1/-1"><div class="detail-key">Address</div><div class="detail-val">${p['Address'] || '—'}</div></div>
        </div>
      </div>`
    : '';

  const horoHtml = `<button class="wa-share-btn" onclick="${currentRole === 'admin' ? 'shareProfile' : 'shareOnWhatsApp'}('${uid}')">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.555 4.116 1.527 5.845L.057 23.25a.75.75 0 00.916.916l5.405-1.47A11.952 11.952 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75a9.718 9.718 0 01-4.942-1.348l-.354-.21-3.668.998.975-3.668-.228-.363A9.72 9.72 0 012.25 12C2.25 6.615 6.615 2.25 12 2.25S21.75 6.615 21.75 12 17.385 21.75 12 21.75z"/></svg>
    ${currentRole === 'admin' ? 'Share Profile' : 'Share Interest'}
  </button>`;

  const el = document.createElement('div');
  el.className = `profile-card ${type}`;
  el.id = cardId;
  el.innerHTML = `
    ${topHtml(p)}
    <div class="card-images">
      <div class="image-slider" id="${cardId}-slider">
        <div class="image-slide active img-loading" data-idx="0">
          ${buildImg(p['Photo 1 - of Bride or Groom'], symbol)}
        </div>
        <div class="image-slide img-loading" data-idx="1">
          ${buildImg(p['Photo 2 - of Bride or Groom'], symbol)}
        </div>
        <button class="img-arrow prev" onclick="prevSlide('${cardId}')">‹</button>
        <button class="img-arrow next" onclick="nextSlide('${cardId}')">›</button>
        <div class="img-count-badge"><span class="${cardId}-cur">1</span>/2</div>
        <div class="img-nav">
          <button class="img-dot active" onclick="goSlide('${cardId}',0)"></button>
          <button class="img-dot"        onclick="goSlide('${cardId}',1)"></button>
        </div>
      </div>
    </div>

    <div class="card-details">
      <div class="card-header">
        <div class="name-row">
          <div class="profile-name">${p['Name'] || '—'}</div>
          <div class="uid-row">
            <button class="uid-copy-btn" onclick="copyUID('${uid}',this)" title="Copy ID">
              <span class="uid-text">${uid}</span><span class="uid-copy-icon">⧉</span>
            </button>
          </div>
        </div>
        <div class="tag-row">
          <span class="tag ${type}">${p['Filling the Form Of']}</span>
          ${age !== '—' ? `<span class="tag neutral">${age}</span>` : ''}
          ${p['Height (in feet) - example 5 / 5`2 / 5`11'] ? `<span class="tag neutral">${p['Height (in feet) - example 5 / 5`2 / 5`11']}</span>` : ''}
          ${p['Rashi']     ? `<span class="tag neutral">${p['Rashi']}</span>`   : ''}
          ${p['Nakshatra'] ? `<span class="tag green">${p['Nakshatra']}</span>` : ''}
        </div>
      </div>

      ${staticHtml(p)}
      <div class="card-scroll">
        <div class="detail-section">
          <div class="section-label">Personal</div>
          <div class="detail-grid">
            <div class="detail-item"><div class="detail-key">DOB</div><div class="detail-val">${formatDOB(p['Date Of Birth'])}</div></div>
            <div class="detail-item"><div class="detail-key">Birth Place</div><div class="detail-val">${p['Place of Birth'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Gothra</div><div class="detail-val">${p['Gothra'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Sub-Caste</div><div class="detail-val">${p['Sub Caste'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Mata</div><div class="detail-val">${p['ಮಠ - Mata'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Charana</div><div class="detail-val">${p['Charana'] || '—'}</div></div>
          </div>
        </div>
        <div class="divider"></div>
        <div class="detail-section">
          <div class="section-label">Professional</div>
          <div class="detail-grid">
            <div class="detail-item"><div class="detail-key">Education</div><div class="detail-val">${p['Education '] || p['Education'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Field</div><div class="detail-val">${p['Work Field'] || '—'}</div></div>
            <div class="detail-item" style="grid-column:1/-1"><div class="detail-key">Company / Role</div><div class="detail-val">${p['Currently Working-In(Company Name) and As(Position)'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Salary</div><div class="detail-val">${p['Salary(LPA)'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Degree</div><div class="detail-val">${p['Mention your degrees '] || p['Mention your degrees'] || '—'}</div></div>
          </div>
        </div>
        <div class="divider"></div>
        <div class="detail-section">
          <div class="section-label">Family</div>
          <div class="detail-grid">
            <div class="detail-item"><div class="detail-key">Father</div><div class="detail-val">${p["Father's Name"] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Occ.</div><div class="detail-val">${p['Occupation '] || p['Occupation'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Mother</div><div class="detail-val">${p["Mother's Name"] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Siblings</div><div class="detail-val">${p['Siblings'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Father's Native</div><div class="detail-val">${p["Father's Native"] || '—'}</div></div>
          </div>
        </div>
        <div class="divider"></div>
        <div class="detail-section">
          <div class="section-label">Preferences</div>
          <div class="detail-grid">
            <div class="detail-item"><div class="detail-key">Currently In</div><div class="detail-val">${p['Staying In'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Relocation</div><div class="detail-val">${p['Planning To Relocate'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Age Gap</div><div class="detail-val">${p['Age Gap'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Abroad</div><div class="detail-val">${p['Abroad Relocation'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Language</div><div class="detail-val">${p['Language Preference '] || p['Language Preference'] || '—'}</div></div>
            <div class="detail-item"><div class="detail-key">Same Gothra</div><div class="detail-val">${p['Will agree on Same Gothra'] || '—'}</div></div>
          </div>
        </div>
        <div class="divider"></div>
        ${contactHtml}
      </div>

      <div class="card-footer">
        <button class="contact-btn" onclick="openModal('${uid}')">⊞ Full Details</button>
        ${horoHtml}
      </div>
    </div>
  `;

  _cardCache[uid] = el;
  return el;
}

// =====================================================================
// SLIDE LOGIC
// =====================================================================

function goSlide(id, idx) {
  const slider = document.getElementById(id + '-slider');
  if (!slider) return;
  slider.querySelectorAll('.image-slide').forEach((s, i) => s.classList.toggle('active', i === idx));
  slider.querySelectorAll('.img-dot').forEach((d, i)     => d.classList.toggle('active', i === idx));
  const cur = slider.querySelector(`.${id}-cur`);
  if (cur) cur.textContent = idx + 1;
}

function nextSlide(id) {
  const slider = document.getElementById(id + '-slider');
  if (!slider) return;
  const slides = slider.querySelectorAll('.image-slide');
  const cur    = Array.from(slides).findIndex(s => s.classList.contains('active'));
  goSlide(id, (cur + 1) % slides.length);
}

function prevSlide(id) {
  const slider = document.getElementById(id + '-slider');
  if (!slider) return;
  const slides = slider.querySelectorAll('.image-slide');
  const cur    = Array.from(slides).findIndex(s => s.classList.contains('active'));
  goSlide(id, (cur - 1 + slides.length) % slides.length);
}

// =====================================================================
// PROFILE DETAIL MODAL
// =====================================================================

let _modalIndex = -1;  // current position within `filtered` for prev/next nav

async function openModal(uid) {
  const p = allProfiles.find(x => x['Unique ID'].trim() === uid);
  if (!p) return;

  _modalIndex = filtered.findIndex(x => x['Unique ID'].trim() === uid);

  const isBride = p['Filling the Form Of'] === 'Bride';
  const type    = isBride ? 'bride' : 'groom';
  const symbol  = isBride ? '♀' : '♂';

  const skip = new Set([
    'Unique ID', 'Timestamp', 'Name', 'Filling the Form Of',
    'Photo 1 - of Bride or Groom', 'Photo 2 - of Bride or Groom', 'Horoscope',
    '* I Herby declare that the above particulars furnished is true and correct for the best of my knowledge and for the purpose of finding bride/ groom for self or family members only and will not use profiles for any commercial purposes including agent activities/ brokerage activities or sharing and forwarding to other groups or platforms. I Accept all terms and conditions of Kathyayini Matrimony Services',
  ]);

  const effectiveRole = (_previewGuest && currentRole === 'admin') ? 'guest' : currentRole;

  const visible = (k, v) => v && String(v).trim() && !skip.has(k) &&
    (effectiveRole === 'admin' || !HIDDEN_FOR_GUEST.includes(k));
  const rowHtml = (k, v) => `
      <div class="md-row${String(v).length > 38 ? ' wide' : ''}">
        <div class="md-key">${k.replace(/\s+/g, ' ').trim()}</div>
        <div class="md-val">${k === 'Date Of Birth' ? formatDOB(v) : v}</div>
      </div>`;
  const used = new Set();
  let firstOpen = true;
  const secHtml = Object.entries(DETAIL_SECTIONS).map(([title, keys]) => {
    if (title === 'Admin' && effectiveRole !== 'admin') { keys.forEach(k => used.add(k)); return ''; }
    const rows = keys.filter(k => k in p && visible(k, p[k])).map(k => { used.add(k); return rowHtml(k, p[k]); }).join('');
    if (!rows) return '';
    const open = firstOpen ? ' open' : ''; firstOpen = false;
    return `<details class="md-sec"${open}><summary class="md-sec-title">${title}</summary><div class="md-grid">${rows}</div></details>`;
  }).join('');
  const rest = Object.entries(p).filter(([k, v]) => !used.has(k) && visible(k, v)).map(([k, v]) => rowHtml(k, v)).join('');
  const detailSections = secHtml + (rest ? `<details class="md-sec"><summary class="md-sec-title">Other</summary><div class="md-grid">${rest}</div></details>` : '');

  const photo1 = driveThumbUrl(p['Photo 1 - of Bride or Groom'], 'w600');
  const photo2 = driveThumbUrl(p['Photo 2 - of Bride or Groom'], 'w600');

  const horoUrl = getHoroscopeUrl(p);
  const horoBtn = horoUrl
    ? `<button class="horoscope-btn md-horo-btn" onclick="openHoroscopeLightbox('${horoUrl}','${uid}')">✦ View Horoscope</button>`
    : `<button class="horoscope-btn md-horo-btn" disabled style="opacity:0.4;cursor:not-allowed">✦ No Horoscope</button>`;

  window._modalPhotos = [photo1, photo2].filter(Boolean);
  const quick = currentRole === 'admin' ? `<div class="qa-wrap"><button class="a-btn qa-btn" onclick="toggleQuick(event)">⚡ Quick actions ▾</button>
      <div class="qa-menu" hidden>
        <button onclick="shareProfile('${uid}')">Share profile</button>
        <button onclick="shareStatus('${uid}', document.querySelector('.qa-btn'))">Share details</button>
        <button onclick="openEdit('${uid}')">✎ Edit</button>
        <button class="danger" onclick="deleteProfile('${uid}')">🗑 Delete</button>
      </div></div>` : '';

  document.getElementById('modal-body').innerHTML = `
    <div class="md-layout">
      <div class="md-banner">
        <div class="md-banner-left">
          <span class="md-banner-name">${p['Name'] || '—'}</span>
          <span class="md-banner-tag ${type}">${p['Filling the Form Of']}</span>
        </div>
        <div class="md-banner-right">
          <button class="uid-copy-btn" onclick="copyUID('${uid}',this)" title="Copy ID">
            <span class="uid-text">${uid}</span><span class="uid-copy-icon">⧉</span>
          </button>
          <span class="md-banner-reg">Registered ${(p['Timestamp'] || '').split(' ')[0]}</span>
        </div>
      </div>
      <div class="md-main">
        <div class="md-left" id="md-photos"></div>
        <div class="md-resize-handle" id="md-resize-handle" title="Drag to resize"></div>
        <div class="md-right">
          ${detailSections}
          <div class="md-horo-row"><div class="md-actions-row">${horoBtn}${quick}</div></div>
        </div>
      </div>
    </div>`;

  // Inject photos as real DOM nodes — avoids all URL/quote escaping issues with Drive URLs
  const photoContainer = document.getElementById('md-photos');
  [photo1, photo2].forEach(src => {
    if (!src) {
      const ph = document.createElement('div');
      ph.className = 'md-photo-placeholder';
      ph.textContent = symbol;
      photoContainer.appendChild(ph);
      return;
    }
    const img = document.createElement('img');
    img.className = 'md-photo';
    img.src = src;
    img.alt = 'Profile photo';
    img.addEventListener('error', function() {
      const ph = document.createElement('div');
      ph.className = 'md-photo-placeholder';
      ph.textContent = symbol;
      this.replaceWith(ph);
    });
    img.addEventListener('click', () => openLightboxFromSrc(src));
    photoContainer.appendChild(img);
  });

  // Resizable column divider — drag to adjust photo column width
  const resizeHandle = document.getElementById('md-resize-handle');
  const leftCol = document.getElementById('md-photos');
  const mainRow = leftCol.closest('.md-main');

  resizeHandle.addEventListener('mousedown', startResize);
  resizeHandle.addEventListener('touchstart', startResize, { passive: false });

  function startResize(e) {
    e.preventDefault();
    document.body.classList.add('md-resizing');
    const move = ev => doResize(ev);
    const stop = () => {
      document.body.classList.remove('md-resizing');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stop);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', stop);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', stop);
  }

  function doResize(ev) {
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const rect = mainRow.getBoundingClientRect();
    let newWidth = clientX - rect.left;
    const min = 120, max = rect.width - 200;
    newWidth = Math.max(min, Math.min(max, newWidth));
    leftCol.style.flexBasis = newWidth + 'px';
  }


  // Update prev/next nav button states based on position in filtered list
  const prevBtn = document.getElementById('modal-prev-btn');
  const nextBtn = document.getElementById('modal-next-btn');
  if (prevBtn) prevBtn.style.visibility = _modalIndex > 0 ? 'visible' : 'hidden';
  if (nextBtn) nextBtn.style.visibility = (_modalIndex >= 0 && _modalIndex < filtered.length - 1) ? 'visible' : 'hidden';

  if (!document.getElementById('modal-overlay').classList.contains('open')) {
    try { history.pushState({ km: 1, v: _adminView, m: uid }, ''); } catch (e) {}
  }
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModalUI() { document.getElementById('modal-overlay').classList.remove('open'); }
function closeModal() {
  const open = document.getElementById('modal-overlay').classList.contains('open');
  if (open && history.state && history.state.m) history.back(); else closeModalUI();
}

function navigateModal(dir) {
  const newIndex = _modalIndex + dir;
  if (newIndex < 0 || newIndex >= filtered.length) return;
  const next = filtered[newIndex];
  openModal(next['Unique ID'].trim());
}

document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// =====================================================================
// SEARCH & FILTERS
// =====================================================================

function clearSearch() {
  const input = document.getElementById('search-input');
  input.value = '';
  document.getElementById('search-clear').classList.remove('visible');
  applyFilters();
  input.focus();
}

document.getElementById('search-input').addEventListener('input', function() {
  document.getElementById('search-clear').classList.toggle('visible', this.value.length > 0);
  applyFilters();
});

document.getElementById('caste-filter').addEventListener('change', applyFilters);
document.getElementById('location-filter').addEventListener('change', applyFilters);
document.getElementById('sort-select').addEventListener('change', applyFilters);

document.querySelectorAll('.count-pill[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.count-pill[data-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    applyFilters();
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeLightbox(); closeHoroscopeLightbox(); }

  // Arrow-key navigation between profiles — only when the detail modal is
  // open and no photo/horoscope lightbox is on top of it
  const modalOpen = document.getElementById('modal-overlay').classList.contains('open');
  const lbOpen    = document.getElementById('lightbox-overlay').classList.contains('open');
  const horoOpen  = document.getElementById('horo-lightbox').classList.contains('open');
  if (modalOpen && !lbOpen && !horoOpen) {
    if (e.key === 'ArrowRight') navigateModal(1);
    if (e.key === 'ArrowLeft')  navigateModal(-1);
  }
});

function resetFilters() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').classList.remove('visible');
  document.getElementById('caste-filter').value = '';
  document.getElementById('location-filter').value = '';
  document.getElementById('sort-select').value = 'dob_desc';

  document.querySelectorAll('.count-pill[data-filter]').forEach(b => b.classList.remove('active'));
  document.getElementById('pill-all').classList.add('active');
  activeFilter = 'all';

  applyFilters();
}

function applyFilters() {
  const search   = document.getElementById('search-input').value.toLowerCase().trim();
  const caste    = document.getElementById('caste-filter').value;
  const location = document.getElementById('location-filter').value;
  const sort     = document.getElementById('sort-select').value;

  filtered = allProfiles.filter(p => {
    if (activeFilter !== 'all' && p['Filling the Form Of'] !== activeFilter) return false;
    if (caste && p['Sub Caste'] !== caste) return false;
    if (location) {
      const loc  = p['Staying In'] || '';
      const city = p['If currently not staying in Bengaluru Please mention the city'] || '';
      if (!loc.toLowerCase().includes(location.toLowerCase()) &&
          !city.toLowerCase().includes(location.toLowerCase())) return false;
    }
    if (search) {
      const s = [
        p['Name'], p['Gothra'], p['Nakshatra'], p['Sub Caste'],
        p['Work Field'], p['Currently Working-In(Company Name) and As(Position)'],
        p['Rashi'], p['Education '], p['ಮಠ - Mata'], p['Place of Birth'],
      ].join(' ').toLowerCase();
      if (!s.includes(search)) return false;
    }
    return true;
  });

  if      (sort === 'newest')   filtered.sort((a, b) => new Date(b['Timestamp']) - new Date(a['Timestamp']));
  else if (sort === 'oldest')   filtered.sort((a, b) => new Date(a['Timestamp']) - new Date(b['Timestamp']));
  else if (sort === 'name')     filtered.sort((a, b) => (a['Name'] || '').localeCompare(b['Name'] || ''));
  else if (sort === 'dob_asc')  filtered.sort((a, b) => (parseDOB(a['Date Of Birth']) || 0) - (parseDOB(b['Date Of Birth']) || 0));
  else if (sort === 'dob_desc') filtered.sort((a, b) => (parseDOB(b['Date Of Birth']) || 0) - (parseDOB(a['Date Of Birth']) || 0));

  renderGrid();
}

// =====================================================================
// GRID RENDER — reorders existing DOM nodes, never rebuilds them
// =====================================================================

function renderGrid() {
  const grid = document.getElementById('grid');

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="icon">🔍</div><div>No profiles match your filters</div></div>`;
    return;
  }

  // Append/reorder cached card nodes — images are already loaded, no flicker
  const fragment = document.createDocumentFragment();
  filtered.forEach(p => fragment.appendChild(getOrCreateCard(p)));
  grid.innerHTML = '';
  grid.appendChild(fragment);
}

function populateFilters() {
  const castes = [...new Set(allProfiles.map(p => p['Sub Caste']).filter(Boolean))].sort();
  const casteEl = document.getElementById('caste-filter');
  castes.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    casteEl.appendChild(o);
  });

  const locations = [...new Set(allProfiles.map(p => p['Staying In']).filter(Boolean))].sort();
  const locEl = document.getElementById('location-filter');
  locations.forEach(l => {
    const o = document.createElement('option');
    o.value = l; o.textContent = l;
    locEl.appendChild(o);
  });
}

// =====================================================================
// DATA LOADING
// =====================================================================

async function loadData() {
  try {
    const res = await api('getProfiles', { token: sessionToken });
    if (!res.ok) {
      if (res.error === 'unauthorized') {
        clearSession();
        showLoginScreen('Your session has expired. Please sign in again.');
        return;
      }
      throw new Error(res.error || 'Unknown error');
    }
    currentRole = res.role;
    myProfiles  = res.myProfiles || [];
    myProfiles.forEach(m => { if (m.row) tidyCase(m.row); });
    if (Array.isArray(res.cardFields)) cardFields = res.cardFields;
    if (Array.isArray(res.statusFields)) statusFields = res.statusFields;
    try { localStorage.setItem('km_role', res.role); } catch (e) {}
    allProfiles = (res.profiles || []).filter(p => p['Name'] && p['Name'].trim());
    allProfiles.forEach(tidyCase);
    if (res.role === 'admin' && !_admin) loadAdminData();   // warm the Interests/Payments data

    const brides = allProfiles.filter(p => p['Filling the Form Of'] === 'Bride').length;
    const grooms = allProfiles.filter(p => p['Filling the Form Of'] === 'Groom').length;
    document.getElementById('bride-count').textContent = brides;
    document.getElementById('groom-count').textContent = grooms;
    const allCountEl = document.getElementById('all-count');
    if (allCountEl) allCountEl.textContent = allProfiles.length;

    // Members only receive the opposite kind of profile (the server enforces
    // this). Hide the Bride/Groom buttons and relabel "All" to match.
    const restricted = res.role !== 'admin' && (res.viewing === 'Bride' || res.viewing === 'Groom');
    ['pill-bride', 'pill-groom'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.style.display = restricted ? 'none' : '';
    });
    const allPill = document.getElementById('pill-all');
    if (allPill) {
      const label = restricted ? (res.viewing === 'Bride' ? 'Brides' : 'Grooms') : 'All';
      allPill.innerHTML = `${label} <span class="pill-num" id="all-count">${allProfiles.length}</span>`;
    }

    populateFilters();
    filtered = [...allProfiles].sort((a, b) => (parseDOB(b['Date Of Birth']) || 0) - (parseDOB(a['Date Of Birth']) || 0));
    renderGrid();
    checkDeepLink();
  } catch (e) {
    document.getElementById('grid').innerHTML = `
      <div class="loading-state" style="grid-column:1/-1">
        <div style="font-size:36px;margin-bottom:12px">⚠</div>
        <div style="color:var(--rose)">Could not load profiles</div>
        <div style="font-size:12px;margin-top:8px;color:var(--text-dim)">Error: ${e.message}</div>
      </div>`;
  }
}

// =====================================================================
// API HELPER
// =====================================================================

// Sent as text/plain (no custom headers) so the browser skips the CORS
// preflight, which Apps Script web apps do not answer.
async function api(action, payload = {}) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify({ action, ...payload }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data && data.error === 'Unknown action') {
    throw new Error('The server code is out of date. Paste the latest Code.gs into Apps Script and redeploy it as a New version.');
  }
  return data;
}

// =====================================================================
// APP INIT & LOGIN  (email + one-time code)
// =====================================================================

// The session lives in localStorage so every tab of this site shares it
// (opening a shared profile link in a new tab doesn't ask for a new OTP).
// It expires after 2 hours, matching the server-side session.
const SESSION_MAX_MS = 2 * 60 * 60 * 1000;

function storeSession(token, role, email) {
  try {
    localStorage.setItem('km_token', token);
    localStorage.setItem('km_role',  role);
    localStorage.setItem('km_email', email);
    localStorage.setItem('km_exp',   String(Date.now() + SESSION_MAX_MS));
  } catch (e) { /* storage blocked: session works in this tab only */ }
}

function readStoredSession() {
  try {
    const exp = parseInt(localStorage.getItem('km_exp') || '0', 10);
    const token = localStorage.getItem('km_token');
    if (!token || !exp || Date.now() > exp) { clearSession(); return null; }
    return {
      token,
      role:  localStorage.getItem('km_role'),
      email: localStorage.getItem('km_email'),
    };
  } catch (e) { return null; }
}

function clearSession() {
  try {
    ['km_token', 'km_role', 'km_email', 'km_exp'].forEach(k => localStorage.removeItem(k));
  } catch (e) {}
  sessionToken = null; currentRole = null; sessionEmail = null;
}

function initApp() {
  try { if (!history.state || !history.state.km) history.replaceState({ km: 1, v: 'profiles' }, ''); } catch (e) {}
  const lock = document.getElementById('login-screen');
  if (lock) lock.remove();
  document.body.classList.remove('locked');

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.style.display = '';
    logoutBtn.title = sessionEmail || '';
    logoutBtn.innerHTML = `
      <span class="logout-role">${currentRole === 'admin' ? '🔑 Admin' : '👤 Member'}</span>
      <span class="logout-sep">·</span>
      <span class="logout-action">Sign Out</span>`;
  }
  const nav = document.getElementById('bottom-nav');
  nav.style.display = 'flex';
  document.body.classList.add('has-nav');
  nav.querySelectorAll('.nav-tab').forEach(t => {
    t.hidden = (currentRole === 'admin' && t.classList.contains('member-only')) || (currentRole !== 'admin' && t.classList.contains('admin-only'));
  });
  loadData();
}

let _resendTimer = null;

function showLoginScreen(notice) {
  document.body.classList.add('locked');
  let el = document.getElementById('login-screen');
  if (!el) {
    el = document.createElement('div');
    el.id = 'login-screen';
    el.className = 'login-screen';
    el.innerHTML = `
      <div class="login-card">
        <div class="login-brand">Kathyayini Matrimony</div>
        <div class="login-sub">Sign in</div>

        <div id="login-step-email">
          <label class="login-label" for="login-email">Registered email address</label>
          <div class="login-field">
            <input class="login-input" type="email" id="login-email" name="email" placeholder="you@example.com"
                   autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false">
            <div class="email-suggest" id="email-suggest"></div>
          </div>
          <div class="login-msg" id="login-email-msg"></div>
          <button class="login-btn" id="login-send-btn" onclick="sendOtp()">Send verification code</button>
        </div>

        <div id="login-step-otp" style="display:none">
          <div class="login-hint">We sent a 6-digit code to<br><strong id="login-email-shown"></strong></div>
          <label class="login-label" for="login-otp">Verification code</label>
          <input class="login-input login-otp" type="text" id="login-otp" maxlength="6"
                 inputmode="numeric" autocomplete="one-time-code" placeholder="••••••">
          <div class="login-msg" id="login-otp-msg"></div>
          <button class="login-btn" id="login-verify-btn" onclick="verifyOtp()">Verify &amp; sign in</button>
          <div class="login-links">
            <button class="login-link" id="login-resend-btn" onclick="resendOtp()" disabled>Resend code</button>
            <button class="login-link" onclick="backToEmail()">Use a different email</button>
          </div>
        </div>
        <div class="login-foot">New here? <a href="${REGISTER_URL}" target="_blank" rel="noopener noreferrer">Register your profile</a></div>
      </div>`;
    document.body.appendChild(el);

    const emailEl = document.getElementById('login-email');
    emailEl.addEventListener('keydown', e => { if (e.key === 'Enter') { hideEmailSuggest(); sendOtp(); } });
    emailEl.addEventListener('focus', showEmailSuggest);
    emailEl.addEventListener('input', showEmailSuggest);
    document.getElementById('email-suggest').addEventListener('click', e => {
      const pick = e.target.closest('.es-pick'), del = e.target.closest('.es-x');
      if (pick) { emailEl.value = pick.dataset.e; hideEmailSuggest(); document.getElementById('login-send-btn').focus(); }
      if (del)  { forgetEmail(del.dataset.x); showEmailSuggest(); }
    });
    document.addEventListener('click', e => { if (!e.target.closest('.login-field')) hideEmailSuggest(); });
    const otpEl = document.getElementById('login-otp');
    otpEl.addEventListener('keydown', e => { if (e.key === 'Enter') verifyOtp(); });
    otpEl.addEventListener('input', () => {
      otpEl.value = otpEl.value.replace(/\D/g, '').slice(0, 6);
      if (otpEl.value.length === 6) verifyOtp();
    });
  }
  backToEmail();
  if (notice) setLoginMsg('email', notice, false);
  setTimeout(() => document.getElementById('login-email')?.focus(), 50);
}

function setLoginMsg(step, text, isError = true, extra = '') {
  const m = document.getElementById(`login-${step}-msg`);
  if (!m) return;
  m.textContent = text || '';
  m.className = 'login-msg' + (text ? (isError ? ' error' : ' info') : '');
  if (!text || !extra) return;

  const box = document.createElement('div');
  box.className = 'login-register';
  const link = (href, label) => {
    const a = document.createElement('a');
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = label;
    return a;
  };
  if (extra === 'register') {
    box.append('New here? ', link(REGISTER_URL, 'Register your profile'),
               ' using our form, then sign in with the same email.');
  } else if (extra === 'contact') {
    const msg = encodeURIComponent('Hello Kamala! I have registered and would like to activate my account. My email: ' +
      (document.getElementById('login-email')?.value.trim() || ''));
    box.append('Already registered? ', link(`https://wa.me/${WA_NUMBER}?text=${msg}`, 'Contact us on WhatsApp'),
               ' to confirm your payment.');
  }
  m.appendChild(box);
}

function setBusy(btnId, busy, idleText) {
  const b = document.getElementById(btnId);
  if (!b) return;
  b.disabled = busy;
  b.textContent = busy ? 'Please wait…' : idleText;
}

function backToEmail() {
  clearInterval(_resendTimer);
  document.getElementById('login-step-otp').style.display = 'none';
  document.getElementById('login-step-email').style.display = '';
  document.getElementById('login-otp').value = '';
  setLoginMsg('email', '');
  setLoginMsg('otp', '');
}

function startResendCountdown(seconds = 30) {
  const btn = document.getElementById('login-resend-btn');
  clearInterval(_resendTimer);
  let left = seconds;
  btn.disabled = true;
  btn.textContent = `Resend code (${left}s)`;
  _resendTimer = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(_resendTimer);
      btn.disabled = false;
      btn.textContent = 'Resend code';
    } else {
      btn.textContent = `Resend code (${left}s)`;
    }
  }, 1000);
}

async function sendOtp(isResend = false) {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const msgStep = isResend ? 'otp' : 'email';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setLoginMsg('email', 'Please enter a valid email address.');
    return;
  }
  setLoginMsg(msgStep, '');
  if (!isResend) setBusy('login-send-btn', true);
  try {
    const res = await api('requestOtp', { email });
    if (!res.ok) { setLoginMsg(msgStep, res.error || 'Could not send code.', true, res.notRegistered ? 'register' : (res.notPaid ? 'contact' : '')); return; }
    document.getElementById('login-email-shown').textContent = email;
    document.getElementById('login-step-email').style.display = 'none';
    document.getElementById('login-step-otp').style.display = '';
    setLoginMsg('otp', isResend ? 'A new code was requested.' : '', false);
    startResendCountdown(30);
    const otpEl = document.getElementById('login-otp');
    otpEl.value = '';
    otpEl.focus();
  } catch (e) {
    setLoginMsg(msgStep, 'Network error. Please check your connection and try again.');
  } finally {
    if (!isResend) setBusy('login-send-btn', false, 'Send verification code');
  }
}

function resendOtp() { sendOtp(true); }

async function verifyOtp() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const otp   = document.getElementById('login-otp').value.trim();
  if (otp.length !== 6) { setLoginMsg('otp', 'Enter the 6-digit code from your email.'); return; }
  setLoginMsg('otp', '');
  setBusy('login-verify-btn', true);
  try {
    const res = await api('verifyOtp', { email, otp });
    if (!res.ok) {
      setLoginMsg('otp', res.error || 'Verification failed.');
      document.getElementById('login-otp').value = '';
      document.getElementById('login-otp').focus();
      return;
    }
    sessionToken = res.token;
    currentRole  = res.role;
    sessionEmail = res.email;
    storeSession(res.token, res.role, res.email);
    rememberEmail(res.email);
    clearInterval(_resendTimer);
    initApp();
  } catch (e) {
    setLoginMsg('otp', 'Network error. Please try again.');
  } finally {
    setBusy('login-verify-btn', false, 'Verify & sign in');
  }
}

async function logout() {
  const token = sessionToken;
  clearSession();
  try { if (token) await api('logout', { token }); } catch (e) { /* ignore */ }
  location.reload();
}

function togglePrivacy() {
  if (currentRole !== 'admin') return;
  _previewGuest = !_previewGuest;
  const btn = document.getElementById('privacy-btn');
  if (btn) {
    btn.textContent = _previewGuest ? '🔒 Guest View' : '👁 Hide Details';
    btn.classList.toggle('privacy-active', _previewGuest);
  }
  // Clear card cache so cards rebuild with correct contact visibility
  Object.keys(_cardCache).forEach(k => delete _cardCache[k]);
  renderGrid();
}

// =====================================================================
// WHATSAPP SHARE & DEEP LINK
// =====================================================================

const WA_NUMBER = '919739790656'; // WhatsApp number to send to

// Builds a shareable URL for a profile using the UID as the hash
function profileLink(uid) {
  const base = window.location.href.split('#')[0];
  return `${base}#${uid}`;
}

// Opens WhatsApp with a message linking to the profile.
// The link text is masked as the UID so the URL isn't displayed raw.
function shareOnWhatsApp(uid) {
  const p = allProfiles.find(x => x['Unique ID'].trim() === uid);
  const name = p ? p['Name'] : uid;
  const type = p ? p['Filling the Form Of'] : '';

  // The sender's own profile: prefer the opposite kind to the one they liked
  const me = myProfiles.find(m => m.type !== type) || myProfiles[0] || null;

  let msg =
    `Hello Kamala! We are interested in this profile, Please find the profile details below:\n\n` +
    `*${name}* (${type})\n` +
    `Profile ID: *${uid}* - ${profileLink(uid)}`;
  if (me) {
    msg += `\n\nOur profile:\n*${me.name}* (${me.type})\n` +
           `Profile ID: *${me.uid}* - ${profileLink(me.uid)}`;
  }

  // Record the click in the admin's "Interests" sheet (fire-and-forget, so the
  // WhatsApp window still opens instantly and isn't blocked by the browser)
  if (sessionToken && currentRole !== 'admin') {
    api('logInterest', { token: sessionToken, toUid: uid }).catch(() => {});
  }

  const url = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank', 'noopener');
}

// Check on load if a profile UID is in the hash and auto-open its modal
function checkDeepLink() {
  const hash = window.location.hash.slice(1); // strip the #
  if (!hash) return;
  const p = allProfiles.find(x => x['Unique ID'].trim() === hash);
  if (p) openModal(p['Unique ID'].trim());
}

// =====================================================================
// COPY UID
// =====================================================================

function copyUID(uid, btn) {
  navigator.clipboard.writeText(uid).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('uid-copy-ok');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('uid-copy-ok'); }, 1500);
  }).catch(() => {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = uid;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '✓';
    btn.classList.add('uid-copy-ok');
    setTimeout(() => { btn.textContent = '⧉'; btn.classList.remove('uid-copy-ok'); }, 1500);
  });
}

// =====================================================================
// LIGHTBOX — photos
// =====================================================================

(function createLightboxDOM() {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="lightbox-overlay" id="lightbox-overlay" onclick="closeLightboxOnBg(event)">
      <button class="lightbox-close" onclick="closeLightbox()">✕</button>
      <button class="lightbox-arrow prev" id="lb-prev" onclick="lbPrev()">‹</button>
      <img class="lightbox-img" id="lightbox-img" alt="Full size photo">
      <button class="lightbox-arrow next" id="lb-next" onclick="lbNext()">›</button>
      <div class="lightbox-caption" id="lightbox-caption"></div>
    </div>`;
  document.body.appendChild(el.firstElementChild);
})();

let _lbImages = [];
let _lbIndex  = 0;

function openLightbox(imgEl) {
  const slider = imgEl.closest('.image-slider');
  const slides = slider ? [...slider.querySelectorAll('.image-slide')] : [];

  // Use higher-res thumbnail for lightbox
  _lbImages = slides
    .map(s => s.querySelector('img'))
    .filter(Boolean)
    .map(i => i.src.replace('sz=w600', 'sz=w1200'))
    .filter(Boolean);

  const activeSlide = slider ? slider.querySelector('.image-slide.active') : null;
  _lbIndex = activeSlide ? slides.indexOf(activeSlide) : 0;
  if (_lbIndex < 0) _lbIndex = 0;
  if (!_lbImages.length) { _lbImages = [imgEl.src]; _lbIndex = 0; }

  _lbShow();
  _lbPush();
  document.getElementById('lightbox-overlay').classList.add('open');
  document.addEventListener('keydown', _lbKeyHandler);
}

function _lbShow() {
  const img = document.getElementById('lightbox-img');
  const cap = document.getElementById('lightbox-caption');
  img.style.opacity = '0';
  img.src = _lbImages[_lbIndex];
  img.onload = () => { img.style.opacity = '1'; };
  document.getElementById('lb-prev').style.display = _lbImages.length > 1 ? 'flex' : 'none';
  document.getElementById('lb-next').style.display = _lbImages.length > 1 ? 'flex' : 'none';
  cap.textContent = _lbImages.length > 1 ? `${_lbIndex + 1} / ${_lbImages.length}` : '';
}

function lbPrev() { _lbIndex = (_lbIndex - 1 + _lbImages.length) % _lbImages.length; _lbShow(); }
function lbNext() { _lbIndex = (_lbIndex + 1) % _lbImages.length; _lbShow(); }

function openLightboxFromSrc(src) {
  const idOf = u => (String(u).match(/[?&]id=([-\w]+)/) || [])[1];
  const all = (window._modalPhotos || []).map(u => u.replace('sz=w600', 'sz=w1200'));
  const i = all.findIndex(u => idOf(u) && idOf(u) === idOf(src));
  if (all.length > 1 && i > -1) { _lbImages = all; _lbIndex = i; }
  else { _lbImages = [src.replace('sz=w600', 'sz=w1200')]; _lbIndex = 0; }
  _lbShow();
  _lbPush();
  document.getElementById('lightbox-overlay').classList.add('open');
  document.addEventListener('keydown', _lbKeyHandler);
}

function closeLightboxUI() {
  const overlay = document.getElementById('lightbox-overlay');
  if (overlay) overlay.classList.remove('open');
  document.removeEventListener('keydown', _lbKeyHandler);
}
function closeLightbox() {
  const open = document.getElementById('lightbox-overlay').classList.contains('open');
  if (open && history.state && history.state.lb) history.back(); else closeLightboxUI();
}
function _lbPush() {
  if (document.getElementById('lightbox-overlay').classList.contains('open')) return;
  try { history.pushState({ km: 1, v: _adminView, m: (history.state && history.state.m) || null, lb: 1 }, ''); } catch (e) {}
}

function closeLightboxOnBg(e) {
  if (e.target === document.getElementById('lightbox-overlay')) closeLightbox();
}

function _lbKeyHandler(e) {
  if (e.key === 'Escape')     { closeLightbox(); closeHoroscopeLightbox(); }
  if (e.key === 'ArrowRight') lbNext();
  if (e.key === 'ArrowLeft')  lbPrev();
}

// =====================================================================
// HOROSCOPE LIGHTBOX — iframe viewer, works for PDF/image/any Drive file
// =====================================================================

(function createHoroLightboxDOM() {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="lightbox-overlay horo-lightbox" id="horo-lightbox" onclick="closeHoroOnBg(event)">
      <div class="horo-lightbox-inner" id="horo-lightbox-inner">
        <div class="horo-lightbox-header">
          <span class="horo-lightbox-title" id="horo-title">Horoscope</span>
          <button class="lightbox-close" style="position:static;margin-left:auto" onclick="closeHoroscopeLightbox()">✕</button>
        </div>
        <iframe id="horo-frame" class="horo-frame" src="" allowfullscreen></iframe>
        <div class="horo-lightbox-footer">
          <span style="font-size:11px;color:rgba(255,255,255,0.35)">
            If the file doesn't load, your browser may be blocking Drive embeds.
          </span>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el.firstElementChild);
})();

function openHoroscopeLightbox(driveViewUrl, uid) {
  const id = driveFileId(driveViewUrl);
  const embedUrl = id
    ? `https://drive.google.com/file/d/${id}/preview`
    : driveViewUrl;

  document.getElementById('horo-frame').src = embedUrl;
  document.getElementById('horo-title').textContent = uid ? `Horoscope — ${uid}` : 'Horoscope';
  document.getElementById('horo-lightbox').classList.add('open');
}

function closeHoroscopeLightbox() {
  const el = document.getElementById('horo-lightbox');
  if (el) {
    el.classList.remove('open');
    document.getElementById('horo-frame').src = '';
  }
}

function closeHoroOnBg(e) {
  if (e.target === document.getElementById('horo-lightbox')) closeHoroscopeLightbox();
}

// =====================================================================
// STARTUP
// =====================================================================

(function startup() {
  const saved = readStoredSession();
  if (saved && saved.role) {
    sessionToken = saved.token;
    currentRole  = saved.role;
    sessionEmail = saved.email;
    initApp();
  } else {
    showLoginScreen();
  }
})();

// If you sign in or out in one tab, other open tabs follow
window.addEventListener('storage', e => {
  if (e.key === 'km_token' && !e.newValue) location.reload();                 // signed out elsewhere
  if (e.key === 'km_token' && e.newValue && !sessionToken) location.reload(); // signed in elsewhere
});

// =====================================================================
// ADMIN SECTIONS — bottom bar: Profiles · Interests · Payments
// =====================================================================
const escHtml = v => String(v == null ? '' : v).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const INTEREST_STATUSES = ['New', 'Talking', 'Meeting', 'Declined', 'Matched', 'Closed'];
let _adminView = 'profiles', _admin = null;

let _adminAt = 0;

function showView(v, fromPop) {
  if (!fromPop && !(history.state && history.state.v === v && !history.state.m && !history.state.lb)) {
    try { history.pushState({ km: 1, v }, ''); } catch (e) {}
  }
  _adminView = v;
  document.querySelectorAll('.nav-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.view === v);
    b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false');
  });
  const onProfiles = v === 'profiles';
  ['controls-bar', 'grid'].forEach(id => document.getElementById(id).style.display = onProfiles ? '' : 'none');
  document.getElementById('admin-view').style.display = onProfiles ? 'none' : 'block';
  window.scrollTo(0, 0);
  if (onProfiles) return;
  document.getElementById('admin-view').classList.toggle('wide', v === 'compare');
  if (v === 'settings' || v === 'compare' || v === 'myprofile') { renderAdminView(); if (v === 'compare') cmpInit(); return; }
  if (_admin) renderAdminView();                              // instant, from memory
  if (!_admin || Date.now() - _adminAt > 20000) loadAdminData(); // refresh quietly
}

async function loadAdminData() {
  const box = document.getElementById('admin-view');
  const onData = _adminView === 'interests' || _adminView === 'payments';
  if (!_admin && onData) box.innerHTML = '<div class="a-empty">Loading…</div>';
  try {
    const res = await api('adminData', { token: sessionToken });
    if (!res.ok) throw new Error(res.error);
    _admin = res; _adminAt = Date.now();
    if (onData && (_adminView === 'interests' || _adminView === 'payments')) renderAdminView();
  } catch (e) {
    if (!_admin && onData) box.innerHTML = '<div class="a-empty">Could not load. Check your connection and try again.</div>';
  }
}

function renderAdminView() {
  const box = document.getElementById('admin-view');
  box.innerHTML = _adminView === 'interests' ? renderInterests()
                : _adminView === 'settings'  ? (currentRole === 'admin' ? renderSettings() : renderMemberSettings())
                : _adminView === 'myprofile' ? renderMyProfile()
                : _adminView === 'compare'   ? renderCompare() : renderPayments();
}

function renderInterests() {
  const list = _admin.interests;
  if (!list.length) return '<h2 class="a-title">Interests</h2><div class="a-empty">No interests yet.</div>';
  return '<h2 class="a-title">Interests</h2>' + list.map(i => `
    <div class="a-card">
      <div class="a-row"><strong>${escHtml(i.fromName || 'Unknown')} → ${escHtml(i.toName)}</strong>
        <span class="a-date">${escHtml(i.date)}</span></div>
      <div class="a-sub">${escHtml(i.fromUid)} → ${escHtml(i.toUid)}</div>
      <div class="a-actions">
        <select class="filter-btn st-${escHtml(i.status)}" onchange="setInterestStatus(${i.row}, this.value)">
          ${INTEREST_STATUSES.map(s => `<option${s === i.status ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="a-btn" onclick="openModal('${escHtml(i.fromUid)}')">View sender</button>
        <button class="a-btn" onclick="openModal('${escHtml(i.toUid)}')">View profile</button>
      </div>
    </div>`).join('');
}

function paymentCard(p, i, tag) {
  const wa = String(p.phone || '').replace(/\D/g, '');
  return `<div class="a-card">
    <div class="a-row"><strong>${escHtml(p.name)}</strong><span class="a-date">${escHtml(p.type)} · ${escHtml(p.uid)}</span></div>
    <div class="a-sub">${p.until ? 'Paid until ' + escHtml(p.until) : tag}
      ${wa ? ` · <a href="https://wa.me/91${wa.slice(-10)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</div>
    <div class="a-actions">
      <input type="date" class="filter-btn" id="until-${tag}-${i}" aria-label="Paid until">
      <button class="a-btn a-primary" onclick="markPaid('${escHtml(p.uid)}','until-${tag}-${i}',this)">Mark paid</button>
    </div></div>`;
}

function renderPayments() {
  const sec = (title, list, tag) => `<h3 class="a-h3">${title} (${list.length})</h3>` +
    (list.length ? list.map((p, i) => paymentCard(p, i, tag)).join('') : '<div class="a-empty">None</div>');
  return '<h2 class="a-title">Payments</h2>' +
    sec('Registered, not paid', _admin.unpaid, 'unpaid') +
    sec('Renewals due in 7 days', _admin.due, 'due') +
    sec('Access expired', _admin.expired, 'expired');
}

async function setInterestStatus(row, status) {
  try { await api('adminAction', { token: sessionToken, what: 'interestStatus', row, status }); }
  catch (e) { alert('Could not save. Please try again.'); }
  loadAdminData();
}

async function markPaid(uid, inputId, btn) {
  const d = document.getElementById(inputId).value;           // yyyy-mm-dd
  const until = d ? d.split('-').reverse().join('/') : '';     // DD/MM/YYYY
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await api('adminAction', { token: sessionToken, what: 'markPaid', uid, until });
    if (!res.ok) throw new Error(res.error);
    ['unpaid', 'due', 'expired'].forEach(k => { _admin[k] = _admin[k].filter(x => x.uid !== uid); });
    renderAdminView();
  } catch (e) { alert('Could not save: ' + (e.message || 'try again')); }
  loadAdminData();
}


// =====================================================================
// DISPLAY: "RAMESH KUMAR" / "ramesh kumar" → "Ramesh Kumar"
// =====================================================================
const NAME_FIELDS  = ['Name', "Father's Name", "Mother's Name"];
const TIDY_FIELDS  = ['Place of Birth', 'Education', 'Work Field', "Father's Occupation", "Mother's Occupation",
  "Father's Native", "Mother's Native", 'Siblings', 'Address', 'Staying In', 'Gothra', 'Sub Caste',
  'Mention your degrees', 'If currently not staying in Bengaluru Please mention the city',
  'Currently Working-In(Company Name) and As(Position)'];

function titleCase(str) {
  return str.toLowerCase().replace(/(^|[\s\-\/(.,])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}
function tidyCase(p) {
  NAME_FIELDS.forEach(k => {
    if (p[k]) p[k] = titleCase(p[k].trim());
  });
  TIDY_FIELDS.forEach(k => {
    const v = p[k];
    if (!v) return;
    const allSame = v === v.toUpperCase() || v === v.toLowerCase();
    const shortAcronym = v === v.toUpperCase() && !/\s/.test(v) && v.length <= 4; // keep MBA, IT, BE
    const shortLower = v === v.toLowerCase() && !/\s/.test(v) && v.length <= 3; // it → IT, ca → CA
    if (shortLower) p[k] = v.toUpperCase();
    else if (allSame && !shortAcronym) p[k] = titleCase(v);
  });
}

// =====================================================================
// ADMIN: DELETE A PROFILE (needs a code emailed to the admin)
// =====================================================================
async function deleteProfile(uid) {
  const p = allProfiles.find(x => x['Unique ID'] === uid);
  if (!confirm(`Delete ${p ? p['Name'] : uid} (${uid})?\n\nA code will be emailed to you to confirm.`)) return;
  try {
    const r1 = await api('deleteOtp', { token: sessionToken, uid });
    if (!r1.ok) throw new Error(r1.error);
    const otp = prompt('Enter the 6-digit code sent to your email:');
    if (!otp) return;
    const r2 = await api('deleteProfile', { token: sessionToken, uid, otp: otp.trim() });
    if (!r2.ok) throw new Error(r2.error);
    allProfiles = allProfiles.filter(x => x['Unique ID'] !== uid);
    closeModal();
    applyFilters();
    updateCounts();
    if (_admin) loadAdminData();
    alert('Profile deleted. A copy is kept in the "Deleted Profiles" tab of your sheet.');
  } catch (e) {
    alert('Not deleted: ' + (e.message || 'please try again'));
  }
}


// =====================================================================
// CARD DETAILS (mobile square cards) + SETTINGS
// =====================================================================
const LABELS = { 'Staying In': 'Location', 'ಮಠ - Mata': 'Mata',
  'Currently Working-In(Company Name) and As(Position)': 'Company & Role', 'Salary(LPA)': 'Salary (LPA)' };
const STATIC_KEYS = ['Date Of Birth', 'Gothra', 'Height (in feet) - example 5 / 5`2 / 5`11']; // always shown, never chosen
const fieldLabel = k => LABELS[k] || k.replace(/\(.*?\)/g, '').split(' - ')[0].replace(/^\*+\s*/, '').trim();

function staticHtml(p) {
  const rows = cardFields.filter(k => STATIC_KEYS.indexOf(k) === -1).map(k => {
    const v = k === 'Date Of Birth' ? formatDOB(p[k]) : p[k];
    return v && v !== '—' ? `<div class="cs-row"><span>${escHtml(fieldLabel(k))}</span>${escHtml(v)}</div>` : '';
  }).join('');
  return `<div class="card-static">${rows}</div>`;
}

const NOT_SELECTABLE = ['Unique ID', 'Timestamp', 'Name', 'Photo 1 - of Bride or Groom', 'Photo 2 - of Bride or Groom',
  'Horoscope', 'Payment Status', 'Paid Until', 'Status', 'Admin Notes', 'Email Address', 'Phone Number', 'Address',
  'First contact', 'Second contact', ...STATIC_KEYS];

function renderSettings() {
  const keys = []; allProfiles.forEach(p => Object.keys(p).forEach(k => {
    if (k && k.trim() && keys.indexOf(k) === -1 && NOT_SELECTABLE.indexOf(k) === -1 && !k.startsWith('* I Her')) keys.push(k);
  }));
  const STATUS_NO = ['Unique ID', 'Timestamp', 'Name', 'Photo 1 - of Bride or Groom', 'Photo 2 - of Bride or Groom', 'Horoscope',
    'Payment Status', 'Paid Until', 'Status', 'Admin Notes'];
  const statusKeys = []; allProfiles.forEach(p => Object.keys(p).forEach(k => {
    if (k && k.trim() && statusKeys.indexOf(k) === -1 && STATUS_NO.indexOf(k) === -1 && !k.startsWith('* I Her')) statusKeys.push(k);
  }));
  const list = (cls, chosen, ks = keys) => ks.map(k => `<label class="set-row"><input type="checkbox" class="${cls}" value="${escHtml(k)}"${chosen.indexOf(k) > -1 ? ' checked' : ''}> ${escHtml(fieldLabel(k))}</label>`).join('');
  const row = (title, desc, cls, chosen, fn, ks) => `
    <details class="set-acc">
      <summary><span class="sa-t">${title}</span><span class="sa-d">${desc}</span><span class="sa-n">${chosen.length} selected</span></summary>
      <div class="sa-body"><div class="set-grid">${list(cls, chosen, ks)}</div>
        <div class="a-actions"><button class="a-btn a-primary" onclick="${fn}(this)">Save</button></div></div>
    </details>`;
  return `<h2 class="a-title">Settings</h2>
    <div class="set-group">For users<small>Changes what every user sees</small></div>` +
    row('Profile cards', 'Details beside the photo, up to 12', 'set-card', cardFields, 'saveCardFields') +
    `<div class="set-group admin">Admin only<small>Only you can see these</small></div>` +
    row('WhatsApp Status image', 'Any detail, including contacts, up to 14', 'set-status', statusFields, 'saveStatusFields', statusKeys) +
    `<details class="set-acc" ontoggle="if (this.open) loadDelReq()">
      <summary><span class="sa-t">Deletion requests</span><span class="sa-d">Members asking to delete their profile</span></summary>
      <div class="sa-body" id="delreq-box"></div></details>` +
    `<details class="set-acc" ontoggle="if (this.open) loadDeleted()">
      <summary><span class="sa-t">Deleted profiles</span><span class="sa-d">Restore a profile deleted by mistake</span></summary>
      <div class="sa-body" id="deleted-box"></div></details>`;
}

async function saveCardFields(btn) {
  const fields = [...document.querySelectorAll('.set-card:checked')].map(i => i.value);
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await api('saveSettings', { token: sessionToken, fields, which: 'card' });
    if (!r.ok) throw new Error(r.error);
    cardFields = fields;
    Object.keys(_cardCache).forEach(k => delete _cardCache[k]);
    applyFilters();
    btn.textContent = 'Saved ✓';
  } catch (e) { alert('Could not save: ' + (e.message || 'try again')); btn.textContent = 'Save'; }
  btn.disabled = false;
}

async function saveStatusFields(btn) {
  const fields = [...document.querySelectorAll('.set-status:checked')].map(i => i.value);
  if (fields.length > 14) { alert('Choose up to 14 fields for the Status image.'); return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await api('saveSettings', { token: sessionToken, fields, which: 'status' });
    if (!r.ok) throw new Error(r.error);
    statusFields = fields;
    btn.textContent = 'Saved ✓';
  } catch (e) { alert('Could not save: ' + (e.message || 'try again')); btn.textContent = 'Save'; }
  btn.disabled = false;
}

// =====================================================================
// ADMIN: SHARE PROFILE (opens WhatsApp's contact picker) + EDIT PROFILE
// =====================================================================
function shareProfile(uid) {
  const p = allProfiles.find(x => x['Unique ID'].trim() === uid);
  const msg = `Please find the profile details below:\n\n*${p ? p['Name'] : uid}* (${p ? p['Filling the Form Of'] : ''})\n` +
              `Profile ID: *${uid}* - ${profileLink(uid)}`;
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank', 'noopener');
}

const EDIT_SECTIONS = {
  'Personal': ['Name', 'Date Of Birth', 'Time Of Birth', 'Place of Birth', 'Marital Status', 'Nakshatra', 'Charana', 'Rashi',
    'Gothra', 'Sub Caste', 'ಮಠ - Mata', 'Height (in feet) - example 5 / 5`2 / 5`11', 'Personal Habits', 'Language Preference'],
  'Professional': ['Education', 'Mention your degrees', 'Work Field', 'Currently Working-In(Company Name) and As(Position)', 'Salary(LPA)'],
  'Family': ["Father's Name", "Father's Occupation", "Father's Native", "Mother's Name",
    "Mother's Occupation", "Mother's Native", 'Siblings'],
  'Preferences': ['Age Gap', 'Will agree on Same Gothra', 'Will agree on any Bhramins and Mata', 'Required Martial Status',
    'Abroad Relocation', 'Local Relocation', 'Planning To Relocate'],
  'Location & Contact': ['Staying In', 'If currently not staying in Bengaluru Please mention the city', 'Address', 'Phone Number', 'First contact', 'Second contact', 'Email Address'],
  'Admin': ['Payment Status', 'Paid Until', 'Status', 'Admin Notes'],
};

function openEdit(uid, own) {
  const p = own ? (myProfiles.find(m => m.uid === uid) || {}).row : allProfiles.find(x => x['Unique ID'] === uid);
  if (!p) return;
  let n = 0;
  const secs = Object.entries(EDIT_SECTIONS).map(([title, keys], si) => {
    if (own && title === 'Admin') return '';
    const fields = keys.filter(k => k in p && !(own && OWN_LOCKED.indexOf(k) > -1)).map(k => {
      const id = 'dl' + (n++);
      if (EDIT_CHOICES[k]) {
        const cur = p[k] || '', list = cur && EDIT_CHOICES[k].indexOf(cur) === -1 ? [cur, ...EDIT_CHOICES[k]] : EDIT_CHOICES[k];
        return `<label class="ed-f"><span>${escHtml(fieldLabel(k))}</span><select data-k="${escHtml(k)}" data-orig="${escHtml(cur)}">
          ${cur ? '' : '<option value=""></option>'}${list.map(o => `<option${o === cur ? ' selected' : ''}>${escHtml(o)}</option>`).join('')}</select></label>`;
      }
      if (k === 'Paid Until') {
        const iso = dmyToIso(p[k]);
        return `<label class="ed-f"><span>Paid until</span><input type="date" data-k="${escHtml(k)}" data-orig="${iso}" value="${iso}"></label>`;
      }
      const opts = [...new Set(allProfiles.map(x => x[k]).filter(Boolean))].slice(0, 60);
      return `<label class="ed-f"><span>${escHtml(fieldLabel(k))}</span>
        <input data-k="${escHtml(k)}" data-orig="${escHtml(p[k] || '')}" value="${escHtml(p[k] || '')}" list="${id}">
        <datalist id="${id}">${opts.map(o => `<option value="${escHtml(o)}">`).join('')}</datalist></label>`;
    }).join('');
    return fields ? `<details class="ed-sec"${si === 0 ? ' open' : ''}><summary>${title}</summary>${fields}</details>` : '';
  }).join('');
  const el = document.createElement('div');
  el.id = 'edit-panel'; el.className = 'edit-panel';
  el.innerHTML = `<div class="ed-box"><div class="ed-head"><strong>Edit ${escHtml(p['Name'])}</strong>
    <button class="a-btn" onclick="closeEdit()">✕</button></div><div class="ed-body">${secs}</div>
    <div class="ed-foot"><button class="a-btn a-primary" onclick="saveEdit('${escHtml(uid)}',this,${!!own})">Save changes</button></div></div>`;
  document.body.appendChild(el);
  el.querySelectorAll('.ed-sec').forEach(d => d.addEventListener('toggle', () => {
    if (d.open) el.querySelectorAll('.ed-sec').forEach(o => { if (o !== d) o.open = false; });
  }));
}
const closeEdit = () => document.getElementById('edit-panel')?.remove();

async function saveEdit(uid, btn, own) {
  const changes = {};
  document.querySelectorAll('#edit-panel [data-k]').forEach(i => {
    if (i.value === i.dataset.orig) return;
    changes[i.dataset.k] = i.dataset.k === 'Paid Until' ? (i.value ? i.value.split('-').reverse().join('/') : '') : i.value.trim();
  });
  if (!Object.keys(changes).length) { closeEdit(); return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await api(own ? 'updateMyProfile' : 'updateProfile', { token: sessionToken, uid, changes });
    if (!r.ok) throw new Error(r.error);
    if (own) {
      Object.assign(myProfiles.find(m => m.uid === uid).row, changes);
      closeEdit(); renderAdminView();
      return;
    }
    const p = allProfiles.find(x => x['Unique ID'] === uid);
    Object.assign(p, changes);
    delete _cardCache[uid];
    closeEdit(); applyFilters(); openModal(uid);
  } catch (e) { alert('Could not save: ' + (e.message || 'try again')); btn.disabled = false; btn.textContent = 'Save changes'; }
}

// =====================================================================
// SWIPE through card photos
// =====================================================================
(function () {
  let sx = 0, sy = 0, el = null;
  document.addEventListener('touchstart', e => {
    el = e.target.closest('.image-slider');
    if (el) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!el) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    const id = el.id.replace('-slider', ''); el = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? nextSlide : prevSlide)(id);
  }, { passive: true });
})();


// =====================================================================
// LOGIN: suggest emails previously signed in with on this device
// =====================================================================
const EMAIL_KEY = 'km_emails';
function savedEmails() { try { return JSON.parse(localStorage.getItem(EMAIL_KEY) || '[]'); } catch (e) { return []; } }
function rememberEmail(e) {
  try { localStorage.setItem(EMAIL_KEY, JSON.stringify([e, ...savedEmails().filter(x => x !== e)].slice(0, 5))); } catch (err) {}
}
function forgetEmail(e) {
  try { localStorage.setItem(EMAIL_KEY, JSON.stringify(savedEmails().filter(x => x !== e))); } catch (err) {}
}
function hideEmailSuggest() { const b = document.getElementById('email-suggest'); if (b) b.style.display = 'none'; }
function showEmailSuggest() {
  const box = document.getElementById('email-suggest');
  const typed = document.getElementById('login-email').value.trim().toLowerCase();
  const list = savedEmails().filter(e => e.includes(typed) && e !== typed);
  if (!box || !list.length) { hideEmailSuggest(); return; }
  box.innerHTML = list.map(e => `<div class="es-row">
    <button type="button" class="es-pick" data-e="${escHtml(e)}">${escHtml(e)}</button>
    <button type="button" class="es-x" data-x="${escHtml(e)}" aria-label="Remove ${escHtml(e)}">✕</button></div>`).join('');
  box.style.display = 'block';
}


// =====================================================================
// WHATSAPP STATUS IMAGE — drawn on a canvas, shared through the phone's share menu
// =====================================================================
function fitText(ctx, text, maxW) {
  let t = String(text);
  while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -1);
  return t === String(text) ? t : t.trimEnd() + '…';
}

function loadImg(src) {
  return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
}

function wrapText(g, text, maxW) {
  const lines = []; let cur = '';
  String(text).split(/\s+/).forEach(w => {
    const t = cur ? cur + ' ' + w : w;
    if (g.measureText(t).width <= maxW) { cur = t; return; }
    if (cur) lines.push(cur);
    while (g.measureText(w).width > maxW && w.length > 1) {
      let i = w.length; while (i > 1 && g.measureText(w.slice(0, i)).width > maxW) i--;
      lines.push(w.slice(0, i)); w = w.slice(i);
    }
    cur = w;
  });
  if (cur) lines.push(cur);
  return lines;
}

function drawStatus(p, uid, photo) {
  const W = 1080, H = 1920, F = '"DM Sans", "Noto Sans Kannada", sans-serif';
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fffaf4'; g.fillRect(0, 0, W, H);

  // chosen fields: long values wrap onto more lines; rows shrink a little if many are chosen
  const fields = statusFields
    .map(k => ({ k, v: k === 'Date Of Birth' ? formatDOB(p[k]) : p[k] })).filter(f => f.v && f.v !== '—');
  const TOP = 130, NAME_H = 110, FOOT = 120, GAP = 20, VALW = 600;
  let rows = [], total = 0, sc = 1;
  for (const s of [1, 0.9, 0.8, 0.7]) {
    sc = s; g.font = `500 ${Math.round(40 * s)}px ${F}`;
    rows = fields.map(f => {
      const lines = wrapText(g, f.v, VALW), lh = Math.round(48 * s);
      return { f, lines, lh, h: Math.max(Math.round(92 * s), lines.length * lh + Math.round(44 * s)) };
    });
    total = rows.reduce((a, r) => a + r.h, 0);
    if (H - TOP - NAME_H - FOOT - GAP - total >= 560) break;
  }
  const photoH = Math.max(420, H - TOP - NAME_H - FOOT - GAP - total);

  g.fillStyle = '#7a5218'; g.fillRect(0, 0, W, TOP);                         // header
  g.fillStyle = '#fff'; g.font = `500 56px ${F}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('Kathyayini Matrimony', W / 2, 66);

  g.fillStyle = '#ede4d8'; g.fillRect(0, TOP, W, photoH);                    // photo
  if (photo) {
    const k = Math.max(W / photo.width, photoH / photo.height), sw = W / k, sh = photoH / k;
    g.drawImage(photo, (photo.width - sw) / 2, Math.max(0, (photo.height - sh) * 0.15), sw, sh, 0, TOP, W, photoH);
  } else {
    g.fillStyle = '#9a8570'; g.font = `400 44px ${F}`; g.fillText('Photo not available', W / 2, TOP + photoH / 2);
  }

  let y = TOP + photoH;                                                      // name · age · DOB · gothra · height
  const age = getAge(p['Date Of Birth']);
  g.textAlign = 'right'; g.fillStyle = '#6b5440'; g.font = `500 44px ${F}`;
  const ageText = age !== '—' ? String(age) : '';
  if (ageText) g.fillText(ageText, W - 60, y + 50);
  const ageW = ageText ? g.measureText(ageText).width + 30 : 0;
  g.textAlign = 'left'; g.fillStyle = '#1a100a'; g.font = `700 60px ${F}`;
  g.fillText(fitText(g, p['Name'], W - 120 - ageW), 60, y + 50);
  y += NAME_H;

  rows.forEach(r => {                                                        // chosen fields
    g.strokeStyle = '#e4d6c3'; g.lineWidth = 2; g.beginPath(); g.moveTo(60, y); g.lineTo(W - 60, y); g.stroke();
    const first = y + Math.round(46 * sc);
    g.textAlign = 'left'; g.fillStyle = '#6b5440'; g.font = `400 ${Math.round(36 * sc)}px ${F}`;
    g.fillText(fieldLabel(r.f.k), 60, first);
    g.textAlign = 'right'; g.fillStyle = '#1a100a'; g.font = `500 ${Math.round(40 * sc)}px ${F}`;
    r.lines.forEach((ln, i) => g.fillText(ln, W - 60, first + i * r.lh));
    y += r.h;
  });

  g.fillStyle = '#f7f0e8'; g.fillRect(0, H - FOOT, W, FOOT);                 // footer
  g.fillStyle = '#6b5440'; g.font = `400 34px ${F}`; g.textAlign = 'center';
  g.fillText(`Profile ID ${uid}`, W / 2, H - FOOT + 40);
  g.fillText('Message us on WhatsApp to connect', W / 2, H - FOOT + 84);
  return c;
}

const _photoCache = {};

async function renderStatus(uid, which) {
  const p = allProfiles.find(x => x['Unique ID'] === uid);
  const key = uid + ':' + which;
  if (!(key in _photoCache)) {
    try {
      const r = await api('photoData', { token: sessionToken, uid, which });
      _photoCache[key] = r.ok && r.photo ? { src: r.photo } : { reason: r.reason || r.error || 'The photo could not be loaded.' };
    } catch (e) { _photoCache[key] = { reason: e.message || 'The photo could not be loaded.' }; }
  }
  let photo = null, note = _photoCache[key].reason || '';
  if (_photoCache[key].src) { photo = await loadImg(_photoCache[key].src); if (!photo) note = 'The photo could not be drawn.'; }
  try { await document.fonts.load('500 40px "DM Sans"'); } catch (e) {}
  const c = drawStatus(p, uid, photo);
  if (!c.getContext('2d')) throw new Error('This browser cannot draw the image.');
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  showStatusPreview(blob, `profile-${uid}.png`, note, uid, which, !!p['Photo 2 - of Bride or Groom']);
}

async function makeStatus(uid, which, btn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Preparing…';
  try { await renderStatus(uid, which); } catch (e) { closeStatusPreview(); alert('Could not make the image: ' + (e.message || 'try again')); }
  btn.disabled = false; btn.textContent = label;
}

function showStatusPreview(blob, name, note, uid, which, hasSecond) {
  closeStatusPreview();
  const url = URL.createObjectURL(blob);
  const file = new File([blob], name, { type: 'image/png' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const el = document.createElement('div');
  el.id = 'status-preview'; el.className = 'status-preview';
  el.innerHTML = `<div class="sp-box">
    ${hasSecond ? `<div class="sp-tabs"><button class="a-btn${which === 1 ? ' a-primary' : ''}" onclick="renderStatus('${escHtml(uid)}', 1)">Photo 1</button>
      <button class="a-btn${which === 2 ? ' a-primary' : ''}" onclick="renderStatus('${escHtml(uid)}', 2)">Photo 2</button></div>` : ''}
    <img src="${url}" alt="Status image preview">
    ${note ? `<div class="sp-note">Photo not added: ${escHtml(note)}</div>` : ''}
    <div class="sp-actions">
      ${canShare ? '<button class="a-btn a-primary" id="sp-share">Share</button>' : ''}
      <a class="a-btn" href="${url}" download="${escHtml(name)}">Save image</a>
      <button class="a-btn" onclick="closeStatusPreview()">Close</button>
    </div></div>`;
  document.body.appendChild(el);
  const sb = document.getElementById('sp-share');
  if (sb) sb.onclick = async () => { try { await navigator.share({ files: [file] }); } catch (e) { /* cancelled */ } };
}
const closeStatusPreview = () => document.getElementById('status-preview')?.remove();

function topHtml(p) {
  const age = getAge(p['Date Of Birth']);
  const meta = [formatDOB(p['Date Of Birth']), p['Gothra'], p[STATIC_KEYS[2]]]
    .filter(v => v && v !== '—').map(escHtml).join(' · ');
  return `<div class="card-top"><div class="ct-name">${escHtml(p['Name'])}${age !== '—' ? ` <span>${age}</span>` : ''}</div><div class="ct-meta">${meta}</div></div>`;
}


// Sections shown in Full Details (anything not listed falls under "Other")
const DETAIL_SECTIONS = {
  'Personal': ['Date Of Birth', 'Time Of Birth', 'Place of Birth', 'Marital Status', 'Nakshatra', 'Charana', 'Rashi',
    'Gothra', 'Sub Caste', 'ಮಠ - Mata', 'Height (in feet) - example 5 / 5`2 / 5`11', 'Personal Habits'],
  'Professional': ['Education', 'Mention your degrees', 'Work Field', 'Currently Working-In(Company Name) and As(Position)', 'Salary(LPA)'],
  'Family': ["Father's Name", "Father's Occupation", "Father's Native", "Mother's Name",
    "Mother's Occupation", "Mother's Native", 'Siblings'],
  'Preferences': ['Age Gap', 'Will agree on Same Gothra', 'Will agree on any Bhramins and Mata', 'Required Martial Status',
    'Language Preference', 'Abroad Relocation', 'Local Relocation', 'Planning To Relocate',
    "If you have selected 'To Other Country', please mention the place"],
  'Location & Contact': ['Staying In', 'If currently not staying in Bengaluru Please mention the city',
    "If you have selected 'Other Country', please mention the place", 'Address', 'Phone Number', 'First contact', 'Second contact', 'Email Address'],
  'Admin': ['Payment Status', 'Paid Until', 'Status', 'Admin Notes'],
};


function shareStatus(uid, btn) {
  const p = allProfiles.find(x => x['Unique ID'] === uid);
  const t1 = driveThumbUrl(p['Photo 1 - of Bride or Groom'], 'w200'), t2 = driveThumbUrl(p['Photo 2 - of Bride or Groom'], 'w200');
  if (!t1 || !t2) { makeStatus(uid, t1 ? 1 : (t2 ? 2 : 1), btn); return; }   // only one photo: no choice needed
  closeStatusPreview();
  const el = document.createElement('div');
  el.id = 'status-preview'; el.className = 'status-preview';
  el.innerHTML = `<div class="sp-box"><strong class="sp-title">Which photo for the Status image?</strong>
    <div class="sp-tabs">
      <button class="sp-pick" onclick="pickStatusPhoto('${escHtml(uid)}', 1)"><img src="${t1}" alt="Photo 1">Photo 1</button>
      <button class="sp-pick" onclick="pickStatusPhoto('${escHtml(uid)}', 2)"><img src="${t2}" alt="Photo 2">Photo 2</button>
    </div><button class="a-btn" onclick="closeStatusPreview()">Cancel</button></div>`;
  document.body.appendChild(el);
}

async function pickStatusPhoto(uid, n) {
  document.querySelector('#status-preview .sp-box').innerHTML = '<strong class="sp-title">Preparing the image…</strong>';
  try { await renderStatus(uid, n); } catch (e) { closeStatusPreview(); alert('Could not make the image: ' + (e.message || 'try again')); }
}

// =====================================================================
// ADMIN: COMPARE — brides on the left, grooms on the right
// =====================================================================
const CMP_DEFAULT = ['Date Of Birth', 'Nakshatra', 'Rashi', 'Gothra', 'Sub Caste', STATIC_KEYS[2], 'Education', 'Work Field',
  'Currently Working-In(Company Name) and As(Position)', 'Marital Status', 'Staying In', 'Age Gap'];
let cmpFields = (() => { try { const v = JSON.parse(localStorage.getItem('km_cmp_fields') || 'null'); return Array.isArray(v) && v.length ? v : CMP_DEFAULT; } catch (e) { return CMP_DEFAULT; } })();
let _cmp = { Bride: null, Groom: null };

function renderCompare() {
  const uniq = (type, k) => [...new Set(allProfiles.filter(p => p['Filling the Form Of'] === type).map(p => p[k]).filter(Boolean))].sort();
  const sel = (id, type, label, k) => `<select class="filter-btn" id="${id}-${type}" onchange="cmpList('${type}')"><option value="">${label}</option>${uniq(type, k).map(v => `<option>${escHtml(v)}</option>`).join('')}</select>`;
  const col = (type, title) => `<div class="cmp-col"><div class="cmp-h ${type.toLowerCase()}">${title}</div>
    <input class="filter-btn cmp-search" id="cmp-q-${type}" placeholder="Search name, gothra, star…" oninput="cmpList('${type}')">
    <div class="cmp-filters">${sel('cmp-c', type, 'All sub-castes', 'Sub Caste')}${sel('cmp-l', type, 'All locations', 'Staying In')}
      ${sel('cmp-m', type, 'Any marital status', 'Marital Status')}
      <select class="filter-btn" id="cmp-s-${type}" onchange="cmpList('${type}')"><option value="young">Youngest first</option><option value="old">Oldest first</option></select></div>
    <div class="cmp-list" id="cmp-list-${type}"></div></div>`;
  return `<h2 class="a-title">Compare</h2><div class="cmp-cols">${col('Bride', 'Brides')}${col('Groom', 'Grooms')}</div><div id="cmp-result"></div>`;
}

function cmpInit() { _cmp = { Bride: null, Groom: null }; cmpList('Bride'); cmpList('Groom'); }

function cmpList(type) {
  const v = id => document.getElementById(id + '-' + type).value;
  const q = v('cmp-q').trim().toLowerCase(), c = v('cmp-c'), l = v('cmp-l'), m = v('cmp-m'), old = v('cmp-s') === 'old';
  const t = p => { const d = parseDOB(p['Date Of Birth']); return d ? d.getTime() : null; };
  const list = allProfiles.filter(p => p['Filling the Form Of'] === type && (!c || p['Sub Caste'] === c) && (!l || p['Staying In'] === l) &&
    (!m || p['Marital Status'] === m) && (!q || [p['Name'], p['Gothra'], p['Nakshatra'], p['Unique ID']].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => { const x = t(a), y = t(b); if (x === null) return 1; if (y === null) return -1; return old ? x - y : y - x; });
  document.getElementById('cmp-list-' + type).innerHTML = list.map(p => {
    const age = getAge(p['Date Of Birth']);
    return `<button class="cmp-item${_cmp[type] === p['Unique ID'] ? ' sel' : ''}" onclick="cmpPick('${type}','${escHtml(p['Unique ID'])}')">
      <strong>${escHtml(p['Name'])}</strong><small>${age !== '—' ? age + ' · ' : ''}${escHtml(p['Gothra'] || '')} · ${escHtml(p['Nakshatra'] || '')}</small></button>`;
  }).join('') || '<div class="a-empty">No profiles</div>';
}

function cmpPick(type, uid) {
  _cmp[type] = _cmp[type] === uid ? null : uid;
  cmpList(type);
  cmpResult();
}

function cmpResult() {
  const b = allProfiles.find(p => p['Unique ID'] === _cmp.Bride), g = allProfiles.find(p => p['Unique ID'] === _cmp.Groom);
  const box = document.getElementById('cmp-result');
  if (!b || !g) { box.innerHTML = ''; return; }
  const get = (p, k) => (k === 'Date Of Birth' ? formatDOB(p[k]) : p[k]) || '—';
  const norm = (p, k) => String(p[k] || '').trim().toLowerCase();
  // highlighted when the same: gothra, nakshatra, height — or when marital status differs
  const RULES = { 'Gothra': 'same', 'Nakshatra': 'same', [STATIC_KEYS[2]]: 'same', 'Marital Status': 'differ' };
  const hit = k => { const x = norm(b, k), y = norm(g, k); return RULES[k] === 'same' ? !!x && x === y : RULES[k] === 'differ' ? !!x && !!y && x !== y : false; };
  const rows = cmpFields.map(k => `<tr${hit(k) ? ' class="warn"' : ''}><th>${escHtml(fieldLabel(k))}</th><td>${escHtml(get(b, k))}</td><td>${escHtml(get(g, k))}</td></tr>`).join('');
  const photo = p => { const u = driveThumbUrl(p['Photo 1 - of Bride or Groom'], 'w500'); return u ? `<img class="cmp-photo" src="${u}" alt="${escHtml(p['Name'])}">` : '<div class="cmp-photo none">No photo</div>'; };
  const ab = getAge(b['Date Of Birth']), ag = getAge(g['Date Of Birth']);
  const gap = ab !== '—' && ag !== '—' ? parseInt(ag, 10) - parseInt(ab, 10) : null;
  const notes = [];
  if (hit('Gothra')) notes.push(['Same gothra', 1]);
  if (hit('Nakshatra')) notes.push(['Same nakshatra', 1]);
  if (hit(STATIC_KEYS[2])) notes.push(['Same height', 1]);
  if (hit('Marital Status')) notes.push(['Different marital status', 1]);
  if (gap !== null) notes.push([gap === 0 ? 'Same age' : `Groom is ${Math.abs(gap)} year${Math.abs(gap) > 1 ? 's' : ''} ${gap > 0 ? 'older' : 'younger'}`, 0]);
  box.innerHTML = `<div class="a-card"><table class="cmp-table">
    <tr><th></th><th class="bride">${escHtml(b['Name'])}<small>${ab !== '—' ? ab : ''}</small></th><th class="groom">${escHtml(g['Name'])}<small>${ag !== '—' ? ag : ''}</small></th></tr>
    <tr class="cmp-photos"><th></th><td>${photo(b)}</td><td>${photo(g)}</td></tr>${rows}</table>
    <div class="cmp-notes">${notes.map(([n, bad]) => `<span class="${bad ? 'bad' : ''}">${n}</span>`).join('')}</div>
    <div class="a-actions"><button class="a-btn" onclick="openModal('${escHtml(b['Unique ID'])}')">Open bride</button>
      <button class="a-btn" onclick="openModal('${escHtml(g['Unique ID'])}')">Open groom</button>
      <button class="a-btn cmp-fields-btn" onclick="openCmpFields()">⚙ Fields</button></div></div>`;
}

function openCmpFields() {
  const keys = []; allProfiles.forEach(p => Object.keys(p).forEach(k => {
    if (k && k.trim() && keys.indexOf(k) === -1 && (STATIC_KEYS.indexOf(k) > -1 || NOT_SELECTABLE.indexOf(k) === -1) && !k.startsWith('* I Her')) keys.push(k);
  }));
  const el = document.createElement('div');
  el.id = 'cmp-fields'; el.className = 'edit-panel';
  el.innerHTML = `<div class="ed-box"><div class="ed-head"><strong>Fields to compare</strong><button class="a-btn" onclick="document.getElementById('cmp-fields').remove()">✕</button></div>
    <div class="ed-body"><div class="set-grid">${keys.map(k => `<label class="set-row"><input type="checkbox" class="cmp-fc" value="${escHtml(k)}"${cmpFields.indexOf(k) > -1 ? ' checked' : ''}> ${escHtml(fieldLabel(k))}</label>`).join('')}</div></div>
    <div class="ed-foot"><button class="a-btn a-primary" onclick="saveCmpFields()">Done</button></div></div>`;
  document.body.appendChild(el);
}

function saveCmpFields() {
  const picked = [...document.querySelectorAll('.cmp-fc:checked')].map(i => i.value);
  if (picked.length) {
    cmpFields = picked;
    try { localStorage.setItem('km_cmp_fields', JSON.stringify(picked)); } catch (e) {}
  }
  document.getElementById('cmp-fields')?.remove();
  cmpResult();
}


function updateCounts() {
  const n = t => allProfiles.filter(p => p['Filling the Form Of'] === t).length;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('bride-count', n('Bride')); set('groom-count', n('Groom')); set('all-count', allProfiles.length);
}

// ---- Settings: deleted profiles (view + restore) ----
async function loadDeleted() {
  const box = document.getElementById('deleted-box');
  if (!box) return;
  box.innerHTML = '<div class="a-empty">Loading…</div>';
  try {
    const r = await api('deletedList', { token: sessionToken });
    if (!r.ok) throw new Error(r.error);
    box.innerHTML = r.items.length ? r.items.map(i => `
      <div class="a-card">
        <div class="a-row"><strong>${escHtml(i.name)}</strong><span class="a-date">${escHtml(i.deletedOn)}</span></div>
        <div class="a-sub">${escHtml(i.type)} · ${escHtml(i.uid)} · deleted by ${escHtml(i.deletedBy)}</div>
        <div class="a-actions"><button class="a-btn a-primary" onclick="restoreDeleted(${i.row}, '${escHtml(i.uid)}', this)">Restore</button></div>
      </div>`).join('') : '<div class="a-empty">No deleted profiles.</div>';
  } catch (e) {
    box.innerHTML = `<div class="a-empty">Could not load: ${escHtml(e.message || 'try again')}</div>`;
  }
}

async function restoreDeleted(row, uid, btn) {
  if (!confirm(`Restore ${uid}? It will appear in the profiles list again.`)) return;
  btn.disabled = true; btn.textContent = 'Restoring…';
  try {
    const r = await api('restoreProfile', { token: sessionToken, row, uid });
    if (!r.ok) throw new Error(r.error);
    await loadDeleted();
    await loadData();            // bring the restored profile back into the list and the counts
    showView('settings');
  } catch (e) {
    alert('Could not restore: ' + (e.message || 'try again'));
    btn.disabled = false; btn.textContent = 'Restore';
  }
}


const EDIT_CHOICES = {
  'Status': ['Active', 'On hold', 'In talks', 'Matched', 'Closed', 'Incomplete', 'Duplicate'],
  'Payment Status': ['Registered', 'Paid'],
};
function dmyToIso(v) {
  const m = String(v || '').match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}


function toggleQuick(e) {
  e.stopPropagation();
  const btn = e.currentTarget, menu = btn.nextElementSibling, wasHidden = menu.hidden;
  closeQuick();
  if (!wasHidden) return;
  menu.hidden = false;
  const r = btn.getBoundingClientRect(), h = menu.offsetHeight, w = menu.offsetWidth;
  menu.style.position = 'fixed';
  menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
  menu.style.top = (r.bottom + h + 8 < window.innerHeight ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + 'px';
}
function closeQuick() { document.querySelectorAll('.qa-menu').forEach(m => { m.hidden = true; }); }
document.addEventListener('click', closeQuick);


window.addEventListener('popstate', e => {
  document.querySelectorAll('#edit-panel, #status-preview, #cmp-fields').forEach(x => x.remove());
  document.getElementById('horo-lightbox')?.classList.remove('open');
  const lb = document.getElementById('lightbox-overlay');
  if (lb && lb.classList.contains('open')) { closeLightboxUI(); return; }
  if (document.getElementById('modal-overlay').classList.contains('open')) { closeModalUI(); return; }
  if (e.state && e.state.v && currentRole === 'admin') showView(e.state.v, true);
});

(function lightboxSwipe() {
  let sx = 0; const ov = document.getElementById('lightbox-overlay');
  ov.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  ov.addEventListener('touchend', e => {
    if (_lbImages.length < 2) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 50) (dx < 0 ? lbNext : lbPrev)();
  }, { passive: true });
})();


// =====================================================================
// MEMBERS: MY PROFILE + SETTINGS
// =====================================================================
const OWN_LOCKED = ['Unique ID', 'Timestamp', 'Email Address', 'Filling the Form Of', 'Photo 1 - of Bride or Groom',
  'Photo 2 - of Bride or Groom', 'Horoscope', 'Admin Notes', 'Payment Status', 'Paid Until', 'Status'];

function renderMyProfile() {
  if (!myProfiles.length) return '<h2 class="a-title">My profile</h2><div class="a-empty">We could not find a profile for your email.</div>';
  return '<h2 class="a-title">My profile</h2>' + myProfiles.map(m => {
    const p = m.row || {};
    const photos = ['Photo 1 - of Bride or Groom', 'Photo 2 - of Bride or Groom'].map(k => driveThumbUrl(p[k], 'w400')).filter(Boolean);
    let first = true;
    const secs = Object.entries(DETAIL_SECTIONS).filter(([t]) => t !== 'Admin').map(([t, keys]) => {
      const rows = keys.filter(k => p[k] && String(p[k]).trim()).map(k => `<div class="md-row${String(p[k]).length > 38 ? ' wide' : ''}">
        <div class="md-key">${escHtml(fieldLabel(k))}</div><div class="md-val">${escHtml(k === 'Date Of Birth' ? formatDOB(p[k]) : p[k])}</div></div>`).join('');
      if (!rows) return '';
      const open = first ? ' open' : ''; first = false;
      return `<details class="md-sec"${open}><summary class="md-sec-title">${t}</summary><div class="md-grid">${rows}</div></details>`;
    }).join('');
    return `<div class="a-card"><div class="a-row"><strong>${escHtml(p['Name'] || m.name)}</strong><span class="a-date">${escHtml(m.uid)}</span></div>
      ${photos.length ? `<div class="mp-photos">${photos.map(u => `<img src="${u}" alt="">`).join('')}</div>` : ''}
      <div class="a-actions"><button class="a-btn a-primary" onclick="openEdit('${escHtml(m.uid)}', true)">✎ Edit my profile</button></div>
      ${secs}
      <div class="a-sub">To change photos or the horoscope, <a href="https://wa.me/${WA_NUMBER}" target="_blank" rel="noopener">message us on WhatsApp</a>.</div></div>`;
  }).join('');
}

function renderMemberSettings() {
  const keys = []; const add = o => Object.keys(o || {}).forEach(k => {
    if (k && k.trim() && keys.indexOf(k) === -1 && NOT_SELECTABLE.indexOf(k) === -1 && !k.startsWith('* I Her')) keys.push(k);
  });
  allProfiles.forEach(add); myProfiles.forEach(m => add(m.row));
  const pay = m => {
    const paid = String(m.payment).trim().toLowerCase() === 'paid';
    return `<div class="a-card"><div class="a-row"><strong>${escHtml(m.name)}</strong><span class="a-date">${escHtml(m.uid)}</span></div>
      <div class="a-sub"><span class="pay-badge ${paid ? 'ok' : 'wait'}">${paid ? 'Paid' : 'Payment pending'}</span>
      ${paid && m.until ? ' valid until ' + escHtml(m.until) : ''}${paid ? '' : ' · <a href="https://wa.me/' + WA_NUMBER + '" target="_blank" rel="noopener">Contact us</a>'}</div></div>`;
  };
  const del = m => `<div class="a-card"><div class="a-row"><strong>${escHtml(m.name)}</strong><span class="a-date">${escHtml(m.uid)}</span></div>
    ${m.deletion === 'Pending'
      ? '<div class="a-sub">Deletion requested. Waiting for the admin to approve.</div>'
      : `<div class="a-sub">The admin has to approve before your profile is removed.</div>
         <div class="a-actions"><button class="a-btn a-danger-btn" onclick="requestDeletionClient('${escHtml(m.uid)}', this)">Request deletion</button></div>`}</div>`;
  return `<h2 class="a-title">Settings</h2>
    <details class="set-acc" open><summary><span class="sa-t">Membership</span><span class="sa-d">Your payment status</span></summary>
      <div class="sa-body">${myProfiles.map(pay).join('') || '<div class="a-empty">No profile found.</div>'}</div></details>
    <details class="set-acc"><summary><span class="sa-t">Profile cards</span><span class="sa-d">Details shown on the cards, up to 12</span><span class="sa-n">${cardFields.length} selected</span></summary>
      <div class="sa-body"><div class="set-grid">${keys.map(k => `<label class="set-row"><input type="checkbox" class="set-card" value="${escHtml(k)}"${cardFields.indexOf(k) > -1 ? ' checked' : ''}> ${escHtml(fieldLabel(k))}</label>`).join('')}</div>
        <div class="a-actions"><button class="a-btn a-primary" onclick="saveMyCardFields(this, false)">Save</button>
        <button class="a-btn" onclick="saveMyCardFields(this, true)">Reset to default</button></div></div></details>
    <details class="set-acc"><summary><span class="sa-t">Delete my profile</span><span class="sa-d">Needs the admin's approval</span></summary>
      <div class="sa-body">${myProfiles.map(del).join('') || '<div class="a-empty">No profile found.</div>'}</div></details>`;
}

async function saveMyCardFields(btn, reset) {
  const fields = reset ? [] : [...document.querySelectorAll('.set-card:checked')].map(i => i.value);
  if (!reset && fields.length > 12) { alert('Choose up to 12 fields.'); return; }
  btn.disabled = true;
  try {
    const r = await api('saveMySettings', { token: sessionToken, fields });
    if (!r.ok) throw new Error(r.error);
    cardFields = r.cardFields;
    Object.keys(_cardCache).forEach(k => delete _cardCache[k]);
    applyFilters();
    renderAdminView();
    alert(reset ? 'Back to the default details.' : 'Saved. Your cards will show these details.');
  } catch (e) { alert('Could not save: ' + (e.message || 'try again')); }
  btn.disabled = false;
}

async function requestDeletionClient(uid, btn) {
  if (!confirm('Ask the admin to delete this profile? It is removed only after they approve.')) return;
  btn.disabled = true;
  try {
    const r = await api('requestDeletion', { token: sessionToken, uid });
    if (!r.ok) throw new Error(r.error);
    myProfiles.find(m => m.uid === uid).deletion = 'Pending';
    renderAdminView();
    alert('Request sent. The admin will review it.');
  } catch (e) { alert('Could not send: ' + (e.message || 'try again')); btn.disabled = false; }
}

// ---- Admin: deletion requests ----
async function loadDelReq() {
  const box = document.getElementById('delreq-box');
  if (!box) return;
  box.innerHTML = '<div class="a-empty">Loading…</div>';
  try {
    const r = await api('deletionRequests', { token: sessionToken });
    if (!r.ok) throw new Error(r.error);
    box.innerHTML = r.items.length ? r.items.map(i => `<div class="a-card">
      <div class="a-row"><strong>${escHtml(i.name)}</strong><span class="a-date">${escHtml(i.on)}</span></div>
      <div class="a-sub">${escHtml(i.uid)} · ${escHtml(i.email)}</div>
      <div class="a-actions"><button class="a-btn a-danger-btn" onclick="decideDel(${i.row}, '${escHtml(i.uid)}', true, this)">Approve and delete</button>
        <button class="a-btn" onclick="decideDel(${i.row}, '${escHtml(i.uid)}', false, this)">Reject</button></div></div>`).join('')
      : '<div class="a-empty">No pending requests.</div>';
  } catch (e) { box.innerHTML = `<div class="a-empty">Could not load: ${escHtml(e.message || 'try again')}</div>`; }
}

async function decideDel(row, uid, approve, btn) {
  if (!confirm(approve ? `Delete ${uid}? A copy stays in "Deleted Profiles" so you can restore it.` : `Reject the request for ${uid}?`)) return;
  btn.disabled = true;
  try {
    const r = await api('decideDeletion', { token: sessionToken, row, uid, approve });
    if (!r.ok) throw new Error(r.error);
    await loadDelReq();
    if (approve) await loadData();
  } catch (e) { alert('Could not save: ' + (e.message || 'try again')); btn.disabled = false; }
}
