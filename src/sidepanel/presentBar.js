/* eslint-disable no-undef */
/*
 * Megumin Suite — Present Characters Bar
 *
 * Horizontal portrait strip mounted above/below SillyTavern's chat input
 * (#send_form). Mirrors Doom's Enhancement Suite "Present Characters Panel"
 * shape: full-bleed portrait card + gradient name overlay. Pulls the cast
 * from the AI-emitted World State NPCs Present block and resolves portraits
 * from the existing NPC Bank.
 *
 * Stays decoupled from panel.js render loop — exports its own update hook
 * that the panel call sites already invoke on every message event.
 */

import { extension_settings } from "../../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../../script.js";

const EXT_NAME = "Megumin-Suite";
const SETTINGS_KEY = "presentBar";
const WRAPPER_ID = "meg-pb-wrapper";
const SCROLL_ID = "meg-pb-scroll";
const COUNT_ID = "meg-pb-count";

const DEFAULTS = Object.freeze({
    enabled: true,
    position: "above",         // "above" | "below" | "off"
    cardWidth: 120,            // px
    cardHeight: 160,           // px
});

let initialised = false;
let getCast = () => [];        // injected from panel.js; returns [{ name, fields?, banked? }]

function settings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    if (!extension_settings[EXT_NAME][SETTINGS_KEY]) {
        extension_settings[EXT_NAME][SETTINGS_KEY] = structuredClone(DEFAULTS);
    } else {
        const cur = extension_settings[EXT_NAME][SETTINGS_KEY];
        for (const k of Object.keys(DEFAULTS)) {
            if (cur[k] === undefined) cur[k] = DEFAULTS[k];
        }
    }
    return extension_settings[EXT_NAME][SETTINGS_KEY];
}

function persist() {
    try { saveSettingsDebounced(); } catch (e) { /* */ }
}

function escapeHtml(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isMaleSex(sexStr) {
    return (sexStr || "").trim().toLowerCase().startsWith("m");
}

// -----------------------------------------------------------------------------
// DOM mount + lifecycle
// -----------------------------------------------------------------------------
function buildWrapperHtml() {
    return `
        <div id="${WRAPPER_ID}" class="meg-pb-wrapper">
            <button class="meg-pb-toggle meg-pb-open" id="meg-pb-toggle" type="button" title="Collapse / expand">
                <span class="meg-pb-toggle-dots">
                    <span class="meg-pb-toggle-dot"></span>
                    <span class="meg-pb-toggle-dot"></span>
                    <span class="meg-pb-toggle-dot"></span>
                </span>
                <span class="meg-pb-toggle-label">Characters</span>
                <i class="fa-solid fa-chevron-up meg-pb-toggle-chevron"></i>
            </button>
            <div class="meg-pb-bar meg-pb-expanded" id="meg-pb-bar">
                <div class="meg-pb-header">
                    <span class="meg-pb-title"><i class="fa-solid fa-users"></i> Present Characters</span>
                    <span class="meg-pb-count" id="${COUNT_ID}">0</span>
                </div>
                <button class="meg-pb-arrow meg-pb-left"  id="meg-pb-left"  type="button" tabindex="-1"><i class="fa-solid fa-chevron-left"></i></button>
                <button class="meg-pb-arrow meg-pb-right" id="meg-pb-right" type="button" tabindex="-1"><i class="fa-solid fa-chevron-right"></i></button>
                <div class="meg-pb-scroll" id="${SCROLL_ID}"></div>
            </div>
        </div>
    `;
}

function mountWrapper() {
    if (document.getElementById(WRAPPER_ID)) return;
    const cfg = settings();
    if (cfg.position === "off") return;

    const $sendForm = window.jQuery ? window.jQuery("#send_form") : null;
    const $sheld = window.jQuery ? window.jQuery("#sheld") : null;
    const html = buildWrapperHtml();

    if ($sendForm && $sendForm.length) {
        cfg.position === "below" ? $sendForm.after(html) : $sendForm.before(html);
    } else if ($sheld && $sheld.length) {
        $sheld.append(html);
    } else {
        document.body.insertAdjacentHTML("beforeend", html);
    }

    wireEvents();
    applyCardSize();
    update();
}

function repositionWrapper() {
    const cfg = settings();
    const wrapper = document.getElementById(WRAPPER_ID);
    const $sendForm = window.jQuery ? window.jQuery("#send_form") : null;
    if (cfg.position === "off") {
        if (wrapper) wrapper.remove();
        return;
    }
    if (!wrapper) {
        mountWrapper();
        return;
    }
    if (!$sendForm || !$sendForm.length) return;
    if (cfg.position === "below") $sendForm.after(wrapper);
    else $sendForm.before(wrapper);
}

function wireEvents() {
    const toggle = document.getElementById("meg-pb-toggle");
    const bar = document.getElementById("meg-pb-bar");
    if (toggle && bar) {
        toggle.addEventListener("click", () => {
            const collapsed = bar.classList.toggle("meg-pb-collapsed");
            bar.classList.toggle("meg-pb-expanded", !collapsed);
            toggle.classList.toggle("meg-pb-open", !collapsed);
        });
    }
    const left = document.getElementById("meg-pb-left");
    const right = document.getElementById("meg-pb-right");
    const scroll = document.getElementById(SCROLL_ID);
    if (left && scroll) left.addEventListener("click", () => scroll.scrollBy({ left: -240, behavior: "smooth" }));
    if (right && scroll) right.addEventListener("click", () => scroll.scrollBy({ left:  240, behavior: "smooth" }));
}

function applyCardSize() {
    const cfg = settings();
    const wrapper = document.getElementById(WRAPPER_ID);
    if (!wrapper) return;
    wrapper.style.setProperty("--meg-pb-card-w", cfg.cardWidth + "px");
    wrapper.style.setProperty("--meg-pb-card-h", cfg.cardHeight + "px");
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------
function cardHtml(entry) {
    const name = entry.name || "NPC";
    const banked = entry.banked || null;
    const portrait = banked && banked.pfp ? banked.pfp : "";
    const male = banked ? isMaleSex(banked.sex) : null;
    const accent = male === true ? "meg-pb-card-male"
                  : male === false ? "meg-pb-card-female"
                  : "";
    const initial = (name || "?").trim().charAt(0).toUpperCase();
    const nameEsc = escapeHtml(name);
    const innerImg = portrait
        ? `<img src="${escapeHtml(portrait)}" alt="${nameEsc}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
           <div class="meg-pb-card-emoji" style="display:none;">${initial}</div>`
        : `<div class="meg-pb-card-emoji">${initial}</div>`;

    return `<div class="meg-pb-card ${accent}" data-name="${nameEsc}" title="${nameEsc}">
        ${innerImg}
        <div class="meg-pb-card-name">${nameEsc}</div>
    </div>`;
}

export function update() {
    const cfg = settings();
    const wrapper = document.getElementById(WRAPPER_ID);
    if (!wrapper) return;
    if (!cfg.enabled || cfg.position === "off") {
        wrapper.style.display = "none";
        return;
    }
    wrapper.style.display = "";

    const cast = getCast() || [];
    const scroll = document.getElementById(SCROLL_ID);
    const count = document.getElementById(COUNT_ID);
    if (!scroll) return;
    if (!cast.length) {
        scroll.innerHTML = `<div class="meg-pb-empty">No characters in scene</div>`;
        if (count) count.textContent = "0";
        return;
    }
    scroll.innerHTML = cast.map(cardHtml).join("");
    if (count) count.textContent = String(cast.length);
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
export function initPresentBar({ castGetter } = {}) {
    if (initialised) return;
    initialised = true;
    if (typeof castGetter === "function") getCast = castGetter;

    const mount = () => {
        const cfg = settings();
        if (cfg.position === "off") return;
        mountWrapper();
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
        // Defer slightly so SillyTavern's #send_form is in the DOM
        setTimeout(mount, 250);
    }
}

export function refreshPresentBar() { update(); }

export function getPresentBarSettings() { return settings(); }

export function applyPresentBarChange() {
    const cfg = settings();
    if (cfg.position === "off") {
        const w = document.getElementById(WRAPPER_ID);
        if (w) w.remove();
        return;
    }
    if (!document.getElementById(WRAPPER_ID)) {
        mountWrapper();
    } else {
        repositionWrapper();
        applyCardSize();
        update();
    }
    persist();
}
