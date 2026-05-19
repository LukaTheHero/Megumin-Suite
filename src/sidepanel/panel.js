/* eslint-disable no-undef */
/*
 * Megumin Suite — Side Panel
 *
 * Mounts a fixed side panel that mirrors the trackers Megumin already emits
 * inline in chat (World State, NPC Inner Chatter, Summary, New NPC dossiers)
 * plus profile-stored data (Story Planner, NPC Bank, Ban List).
 *
 * No preset changes needed — we parse the same <details> blocks the AI is
 * already writing, and optionally strip them from the rendered chat DOM.
 */

import { extension_settings, getContext } from "../../../../../extensions.js";
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from "../../../../../../script.js";

import {
    findLastAssistantMessage,
    parseMessage,
    ALL_TRACKER_BLOCKS_REGEX,
} from "./parsers.js";
import {
    initPresentBar,
    refreshPresentBar,
    getPresentBarSettings,
    applyPresentBarChange,
} from "./presentBar.js";

const EXT_NAME = "Megumin-Suite";
const PANEL_ID = "meg-sp-panel";
const FAB_ID = "meg-sp-fab";
const BODY_HIDE_CLASS = "meg-sp-hide-inline";
const BODY_OPEN_CLASS = "meg-sp-panel-open";
const SETTINGS_KEY = "sidePanel";

const DEFAULTS = Object.freeze({
    enabled: true,
    position: "right",     // "right" | "left"
    width: 620,            // px
    collapsed: false,
    hideInline: true,
    sections: {
        worldState: true,
        innerChatter: true,
        summary: true,
        newNpcs: true,
        storyPlan: true,
        npcBank: true,
        banList: true,
    },
});

let initialised = false;
let getProfile = () => ({});   // Injected by index.js so we can read storyPlan/npcBank/banList
let pendingRender = null;

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------
// One-time migrations: bump values that were saved at a prior default which
// has since been raised. Only fires when the saved value matches an *old*
// default exactly — preserves any custom value the user picked.
const LEGACY_DEFAULTS = Object.freeze({
    width: [360], // historic default widths
});

function settings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    if (!extension_settings[EXT_NAME][SETTINGS_KEY]) {
        extension_settings[EXT_NAME][SETTINGS_KEY] = structuredClone(DEFAULTS);
    } else {
        // Backfill any new keys
        const cur = extension_settings[EXT_NAME][SETTINGS_KEY];
        const def = DEFAULTS;
        for (const k of Object.keys(def)) {
            if (cur[k] === undefined) cur[k] = structuredClone(def[k]);
        }
        if (!cur.sections) cur.sections = structuredClone(def.sections);
        for (const k of Object.keys(def.sections)) {
            if (cur.sections[k] === undefined) cur.sections[k] = def.sections[k];
        }
        // Migrate any field still sitting on a retired default
        for (const [k, legacyVals] of Object.entries(LEGACY_DEFAULTS)) {
            if (legacyVals.includes(cur[k]) && cur[k] !== def[k]) cur[k] = def[k];
        }
    }
    return extension_settings[EXT_NAME][SETTINGS_KEY];
}

function persist() {
    try { saveSettingsDebounced(); } catch (e) { /* noop */ }
}

// -----------------------------------------------------------------------------
// DOM helpers
// -----------------------------------------------------------------------------
function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") e.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
        else if (k === "html") e.innerHTML = v;
        else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
    for (const c of children) {
        if (c == null || c === false) continue;
        if (Array.isArray(c)) {
            for (const sub of c) {
                if (sub == null || sub === false) continue;
                e.appendChild(typeof sub === "string" ? document.createTextNode(sub) : sub);
            }
        } else {
            e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
        }
    }
    return e;
}

function escapeHtml(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// -----------------------------------------------------------------------------
// Panel skeleton
// -----------------------------------------------------------------------------
function buildPanelSkeleton() {
    const cfg = settings();

    const fab = el("button", {
        id: FAB_ID,
        class: "meg-sp-fab",
        title: "Megumin Suite Trackers",
    }, el("i", { class: "fa-solid fa-clipboard-list" }));
    fab.addEventListener("click", () => togglePanel());

    const panel = el("aside", {
        id: PANEL_ID,
        class: `meg-sp-panel meg-sp-pos-${cfg.position}${cfg.collapsed ? " meg-sp-collapsed" : ""}`,
        style: { "--meg-sp-width": cfg.width + "px" },
    });

    const header = el("div", { class: "meg-sp-header" },
        el("div", { class: "meg-sp-title" },
            el("i", { class: "fa-solid fa-wand-magic-sparkles" }),
            " Megumin Trackers"),
        el("div", { class: "meg-sp-header-actions" },
            el("button", {
                class: "meg-sp-icon-btn",
                title: "Open NPC Book",
                onclick: () => openNpcBook(),
            }, el("i", { class: "fa-solid fa-book-open" })),
            el("button", {
                class: "meg-sp-icon-btn",
                title: "Refresh from latest message",
                onclick: () => render(),
            }, el("i", { class: "fa-solid fa-rotate" })),
            el("button", {
                class: "meg-sp-icon-btn",
                title: "Collapse panel",
                onclick: () => togglePanel(false),
            }, el("i", { class: "fa-solid fa-xmark" })),
        ),
    );

    const body = el("div", { class: "meg-sp-body" });

    const empty = el("div", { class: "meg-sp-empty", id: "meg-sp-empty" },
        el("i", { class: "fa-solid fa-hat-wizard" }),
        el("p", {}, "No tracker data yet. The panel updates whenever the AI emits a World State, NPC Inner Chatter, or Summary block."),
    );
    body.appendChild(empty);

    // Section containers — filled by render()
    const sections = el("div", { class: "meg-sp-sections", id: "meg-sp-sections" });
    body.appendChild(sections);

    panel.appendChild(header);
    panel.appendChild(body);

    document.body.appendChild(panel);
    document.body.appendChild(fab);
}

// -----------------------------------------------------------------------------
// Section builders
// -----------------------------------------------------------------------------
function section(id, icon, title, contentNode, { open = true, badge = null } = {}) {
    const d = el("details", { class: "meg-sp-section", id: "meg-sp-section-" + id });
    if (open) d.open = true;
    const sum = el("summary", { class: "meg-sp-summary" },
        el("span", { class: "meg-sp-summary-title" },
            el("i", { class: "fa-solid " + icon }),
            " ",
            title),
        badge != null ? el("span", { class: "meg-sp-badge" }, String(badge)) : null,
    );
    d.appendChild(sum);
    d.appendChild(contentNode);
    return d;
}

function renderWorldState(ws) {
    if (!ws) return el("div", { class: "meg-sp-muted" }, "—");
    const rows = [];

    const kv = (label, val) => val ? el("div", { class: "meg-sp-kv" },
        el("span", { class: "meg-sp-kv-key" }, label),
        el("span", { class: "meg-sp-kv-val" }, val),
    ) : null;

    if (ws.dateTime) rows.push(kv("Date & Time", ws.dateTime));
    if (ws.location) rows.push(kv("Location", ws.location));
    if (ws.weather) rows.push(kv("Weather", ws.weather));
    if (ws.scenePhase) rows.push(kv("Scene Phase", ws.scenePhase));

    const container = el("div", { class: "meg-sp-ws" });
    if (rows.filter(Boolean).length) {
        container.appendChild(el("div", { class: "meg-sp-ws-meta" }, rows.filter(Boolean)));
    }

    // PC card
    if (ws.pc && (ws.pc.name || Object.keys(ws.pc.fields || {}).length)) {
        container.appendChild(el("div", { class: "meg-sp-card meg-sp-card-pc" },
            el("div", { class: "meg-sp-card-head" },
                el("i", { class: "fa-solid fa-user" }),
                " ",
                ws.pc.name || "PC"),
            el("div", { class: "meg-sp-card-fields" },
                Object.entries(ws.pc.fields || {}).map(([k, v]) =>
                    el("div", { class: "meg-sp-field" },
                        el("span", { class: "meg-sp-field-key" }, k + ":"),
                        " ",
                        el("span", { class: "meg-sp-field-val" }, v),
                    ))),
        ));
    }

    // NPCs Present is rendered by the Present Characters bar at the bottom
    // of the chat — click any portrait there to open the full sheet.
    // (Previous inline NPC cards removed; bar now owns this section.)

    // Off-screen
    if (ws.offScreen && ws.offScreen.length) {
        container.appendChild(el("div", { class: "meg-sp-card-head meg-sp-card-head-sep" },
            el("i", { class: "fa-solid fa-satellite-dish" }), " Off-Screen"));
        container.appendChild(el("ul", { class: "meg-sp-bullets" },
            ws.offScreen.map(x => el("li", {}, x))));
    }

    // Threads
    if (ws.threads && ws.threads.length) {
        container.appendChild(el("div", { class: "meg-sp-card-head meg-sp-card-head-sep" },
            el("i", { class: "fa-solid fa-fire" }), " Unresolved Threads"));
        container.appendChild(el("ul", { class: "meg-sp-bullets" },
            ws.threads.map(x => el("li", {}, x))));
    }

    if (ws.leftovers && ws.leftovers.length) {
        container.appendChild(el("div", { class: "meg-sp-leftover", html:
            ws.leftovers.map(t => `<div>${escapeHtml(t)}</div>`).join("") }));
    }

    if (!container.children.length) {
        container.appendChild(el("div", { class: "meg-sp-muted" }, "(no fields parsed)"));
    }
    return container;
}

// Find a banked NPC by name (case-insensitive, normalizes whitespace).
// Used to pull portrait/age/sex into the World State + Inner Chatter views.
function lookupBankedNpc(name) {
    if (!name) return null;
    const npcs = getProfile()?.npcBank?.npcs;
    if (!Array.isArray(npcs)) return null;
    const target = name.trim().toLowerCase();
    for (const n of npcs) {
        const nm = (n.name || "").trim().toLowerCase();
        if (!nm) continue;
        if (nm === target) return n;
        // Fuzzy: bank name appears as a whole word in scene name (or vice versa)
        if (nm.split(/\s+/)[0] === target.split(/\s+/)[0]) return n;
    }
    return null;
}

function avatarNode(npc, name) {
    const fallbackChar = (name || "?").trim().charAt(0).toUpperCase();
    const male = npc ? isMaleSex(npc.sex) : null;
    const accentClass = male === true ? "meg-sp-av-male"
                       : male === false ? "meg-sp-av-female"
                       : "meg-sp-av-neutral";
    if (npc && npc.pfp) {
        return el("div", { class: "meg-sp-av " + accentClass },
            el("img", { src: npc.pfp, alt: name || "NPC", onerror: function () { this.style.display = "none"; } }));
    }
    return el("div", { class: "meg-sp-av meg-sp-av-empty " + accentClass },
        el("span", { class: "meg-sp-av-initial" }, fallbackChar));
}

function renderPresentNpcCard(npc) {
    const name = npc.name || "NPC";
    const banked = lookupBankedNpc(name);
    const ageSex = [banked?.age, banked?.sex].filter(Boolean).join(" · ");
    const fields = Object.entries(npc.fields || {});

    return el("div", { class: "meg-sp-pres-card" },
        el("div", { class: "meg-sp-pres-head" },
            avatarNode(banked, name),
            el("div", { class: "meg-sp-pres-titles" },
                el("div", { class: "meg-sp-pres-name" }, name),
                ageSex ? el("div", { class: "meg-sp-pres-meta" }, ageSex) : null,
            ),
            banked
                ? el("button", {
                    class: "meg-sp-pres-book",
                    title: "Open in NPC Book",
                    onclick: () => {
                        const list = getProfile().npcBank?.npcs || [];
                        const idx = list.findIndex(n => (n.name || "").trim().toLowerCase() === (banked.name || "").trim().toLowerCase());
                        openNpcBook(idx >= 0 ? idx : undefined);
                    },
                }, el("i", { class: "fa-solid fa-book-open" }))
                : null,
        ),
        fields.length
            ? el("div", { class: "meg-sp-pres-fields" },
                fields.map(([k, v]) => el("div", { class: "meg-sp-pres-field" },
                    el("span", { class: "meg-sp-pres-field-key" }, k),
                    el("span", { class: "meg-sp-pres-field-val" }, v),
                )))
            : null,
    );
}

function renderInnerChatter(entries) {
    if (!entries || !entries.length) return el("div", { class: "meg-sp-muted" }, "—");
    // Group consecutive lines by the same NPC so multiple thoughts share one avatar
    const groups = [];
    for (const e of entries) {
        const last = groups[groups.length - 1];
        if (last && last.name === e.name) last.quotes.push(e.quote);
        else groups.push({ name: e.name, quotes: [e.quote] });
    }
    const wrap = el("div", { class: "meg-sp-chatter" });
    for (const g of groups) {
        const banked = lookupBankedNpc(g.name);
        wrap.appendChild(el("div", { class: "meg-sp-thought" },
            el("div", { class: "meg-sp-thought-avatar" },
                avatarNode(banked, g.name),
                el("div", { class: "meg-sp-thought-bubbles" },
                    el("div", { class: "meg-sp-bubble meg-sp-bubble-2" }),
                    el("div", { class: "meg-sp-bubble meg-sp-bubble-1" }),
                ),
            ),
            el("div", { class: "meg-sp-thought-content" },
                g.name ? el("div", { class: "meg-sp-thought-name" }, g.name) : null,
                el("div", { class: "meg-sp-thought-quotes" },
                    g.quotes.map(q => el("div", { class: "meg-sp-thought-text" }, q))),
            ),
        ));
    }
    return wrap;
}

function renderSummary(text) {
    if (!text) return el("div", { class: "meg-sp-muted" }, "—");
    return el("div", { class: "meg-sp-summary-text" }, text);
}

function renderNewNpcs(list) {
    if (!list || !list.length) return el("div", { class: "meg-sp-muted" }, "—");
    const wrap = el("div", { class: "meg-sp-newnpcs" });
    for (const n of list) {
        wrap.appendChild(el("div", { class: "meg-sp-card meg-sp-card-newnpc" },
            el("div", { class: "meg-sp-card-head" },
                el("i", { class: "fa-solid fa-user-plus" }), " ", n.name || "Unnamed NPC"),
            Object.keys(n.fields || {}).length
                ? el("div", { class: "meg-sp-card-fields" },
                    Object.entries(n.fields).map(([k, v]) =>
                        el("div", { class: "meg-sp-field" },
                            el("span", { class: "meg-sp-field-key" }, k + ":"),
                            " ",
                            el("span", { class: "meg-sp-field-val" }, v))))
                : el("div", { class: "meg-sp-muted" }, "(no parsed fields)"),
        ));
    }
    return wrap;
}

function renderStoryPlan(plan) {
    if (!plan || !plan.trim()) return el("div", { class: "meg-sp-muted" }, "Story Planner is empty.");
    const lines = plan.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const list = el("ol", { class: "meg-sp-plan" });
    let added = 0;
    for (const ln of lines) {
        const clean = ln.replace(/^[\-\*•]\s*/, "").replace(/^\d+[\.\)]\s*/, "");
        if (!clean) continue;
        list.appendChild(el("li", {}, clean));
        added++;
    }
    if (!added) return el("div", { class: "meg-sp-summary-text" }, plan.trim());
    return list;
}

function isMaleSex(sexStr) {
    return (sexStr || "").trim().toLowerCase().startsWith("m");
}

function renderNpcBank(npcs) {
    const wrap = el("div", { class: "meg-sp-bank" });

    // Action row — open the full NPC Book (existing Megumin UI on the NPCs Bank tab)
    const openBookBtn = el("button", {
        class: "meg-sp-book-btn",
        title: "Open the full NPC Book (browse, edit, upload, generate portraits)",
        onclick: () => openNpcBook(),
    },
        el("i", { class: "fa-solid fa-book-open" }),
        " Open NPC Book",
        npcs && npcs.length
            ? el("span", { class: "meg-sp-book-count" }, String(npcs.length))
            : null,
    );
    wrap.appendChild(openBookBtn);

    if (!npcs || !npcs.length) {
        wrap.appendChild(el("div", { class: "meg-sp-muted", style: { marginTop: "8px" } },
            "No NPCs banked yet. They get added automatically as the AI introduces them."));
        return wrap;
    }

    const grid = el("div", { class: "meg-sp-bank-grid" });
    // Newest first (matches existing UI's reverse-iteration pattern)
    [...npcs].reverse().forEach((n, revIdx) => {
        const idx = npcs.length - 1 - revIdx;
        const male = isMaleSex(n.sex);
        const accentVar = male ? "var(--meg-sp-npc-male, #3b82f6)" : "var(--meg-sp-npc-female, #f43f5e)";
        const portrait = n.pfp
            ? el("img", { class: "meg-sp-npc-pfp", src: n.pfp, alt: n.name || "NPC" })
            : el("div", { class: "meg-sp-npc-pfp meg-sp-npc-pfp-empty" },
                el("i", { class: "fa-solid fa-user-secret" }));

        const ageSex = [n.age, n.sex].filter(Boolean).join(" · ");

        const card = el("div", {
            class: "meg-sp-bank-mini",
            style: { "--accent": accentVar },
            title: "Click to open in NPC Book",
            onclick: () => openNpcBook(idx),
        },
            portrait,
            el("div", { class: "meg-sp-bank-mini-info" },
                el("div", { class: "meg-sp-bank-mini-name" }, n.name || "Unnamed"),
                ageSex ? el("div", { class: "meg-sp-bank-mini-meta" }, ageSex) : null,
                n.occupation
                    ? el("div", { class: "meg-sp-bank-mini-occ" }, n.occupation)
                    : null,
            ),
        );
        grid.appendChild(card);
    });
    wrap.appendChild(grid);
    return wrap;
}

/**
 * Open the existing Megumin Suite settings modal directly on the NPCs Bank
 * tab. Reuses the existing UI so editing / uploads / portrait generation
 * keep working — no duplicated logic.
 *
 * @param {number} [focusIdx] - Optional NPC index to expand on open.
 */
function openNpcBook(focusIdx) {
    const $overlay = window.jQuery ? window.jQuery("#prompt-slot-modal-overlay") : null;
    if (!$overlay || !$overlay.length) {
        // Settings modal hasn't been mounted yet
        try { (window.toastr || console).info("Open Megumin Suite (wand icon) at least once first.", "NPC Book"); } catch (e) { /* */ }
        return;
    }

    // Find the NPCs Bank tab dynamically (tab title-based, not index-based, in
    // case the order changes upstream).
    const dock = document.querySelectorAll("#ps_dynamic_dots .dock-icon");
    let bankIdx = -1;
    dock.forEach((d, i) => {
        if ((d.getAttribute("title") || "").trim() === "NPCs Bank") bankIdx = i;
    });

    // Open modal then switch to tab
    $overlay.fadeIn(200).css("display", "flex");
    if (bankIdx >= 0) {
        const dot = document.getElementById("dot_" + bankIdx);
        if (dot) dot.click();
    }

    // If a specific NPC was requested, expand its card after the tab renders
    if (typeof focusIdx === "number" && focusIdx >= 0) {
        setTimeout(() => {
            const cards = document.querySelectorAll("#ps_stage_content .npc-card");
            // The bank renders newest-first, so we need to figure out the DOM
            // position from the underlying array index. We match by name.
            const targetName = (getProfile().npcBank?.npcs || [])[focusIdx]?.name;
            if (!targetName) return;
            for (const card of cards) {
                if ((card.textContent || "").includes(targetName)) {
                    const header = card.querySelector(".npc-card-header");
                    const body = card.querySelector(".npc-card-body");
                    if (header && body && body.style.display === "none") header.click();
                    card.scrollIntoView({ behavior: "smooth", block: "center" });
                    break;
                }
            }
        }, 300);
    }
}

function renderBanList(items) {
    if (!items || !items.length) return el("div", { class: "meg-sp-muted" }, "No banned phrases yet.");
    return el("ul", { class: "meg-sp-banlist" },
        items.map(p => el("li", {}, typeof p === "string" ? p : (p.phrase || p.text || JSON.stringify(p)))));
}

// -----------------------------------------------------------------------------
// Main render
// -----------------------------------------------------------------------------
function render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const cfg = settings();
    if (!cfg.enabled) {
        panel.style.display = "none";
        document.body.classList.remove(BODY_OPEN_CLASS);
        return;
    }
    panel.style.display = "";
    panel.classList.toggle("meg-sp-collapsed", !!cfg.collapsed);
    panel.classList.remove("meg-sp-pos-left", "meg-sp-pos-right");
    panel.classList.add("meg-sp-pos-" + cfg.position);
    panel.style.setProperty("--meg-sp-width", (cfg.width || 620) + "px");
    document.body.classList.toggle(BODY_OPEN_CLASS, !cfg.collapsed);
    document.body.classList.toggle(BODY_HIDE_CLASS, !!cfg.hideInline);

    const host = panel.querySelector("#meg-sp-sections");
    const empty = panel.querySelector("#meg-sp-empty");
    if (!host) return;

    host.innerHTML = "";

    // Pull last assistant message and parse
    let parsed = { hasAny: false };
    try {
        const ctx = getContext();
        const found = findLastAssistantMessage(ctx?.chat);
        if (found) parsed = parseMessage(found.msg.mes);
    } catch (e) {
        console.warn("[Megumin Side Panel] parse failure", e);
    }

    const prof = getProfile() || {};
    const sp = prof.storyPlan || {};
    const bank = prof.npcBank || {};
    const banList = prof.banList || [];

    const anyChatBlocks = parsed.hasAny || (parsed.newNpcs && parsed.newNpcs.length);
    const anyProfile = (sp.currentPlan && sp.currentPlan.trim())
        || (bank.npcs && bank.npcs.length)
        || (banList && banList.length);

    if (empty) empty.style.display = (anyChatBlocks || anyProfile) ? "none" : "";

    if (cfg.sections.worldState && parsed.worldState) {
        host.appendChild(section("worldState", "fa-thumbtack", "World State",
            renderWorldState(parsed.worldState)));
    }
    if (cfg.sections.innerChatter && parsed.innerChatter && parsed.innerChatter.length) {
        host.appendChild(section("innerChatter", "fa-comment-dots", "NPC Inner Chatter",
            renderInnerChatter(parsed.innerChatter),
            { badge: parsed.innerChatter.length }));
    }
    if (cfg.sections.summary && parsed.summary) {
        host.appendChild(section("summary", "fa-floppy-disk", "Summary",
            renderSummary(parsed.summary)));
    }
    if (cfg.sections.newNpcs && parsed.newNpcs && parsed.newNpcs.length) {
        host.appendChild(section("newNpcs", "fa-user-plus", "New NPC Dossiers",
            renderNewNpcs(parsed.newNpcs),
            { badge: parsed.newNpcs.length }));
    }
    if (cfg.sections.storyPlan && (sp.enabled || (sp.currentPlan && sp.currentPlan.trim()))) {
        host.appendChild(section("storyPlan", "fa-map", "Story Planner",
            renderStoryPlan(sp.currentPlan),
            { open: false }));
    }
    if (cfg.sections.npcBank && bank.npcs && bank.npcs.length) {
        host.appendChild(section("npcBank", "fa-address-book", "NPC Bank",
            renderNpcBank(bank.npcs),
            { open: true, badge: bank.npcs.length }));
    }
    if (cfg.sections.banList && banList && banList.length) {
        host.appendChild(section("banList", "fa-ban", "Ban List",
            renderBanList(banList),
            { open: false, badge: banList.length }));
    }
}

function scheduleRender(delay = 0) {
    if (pendingRender) clearTimeout(pendingRender);
    pendingRender = setTimeout(() => {
        pendingRender = null;
        render();
        try { refreshPresentBar(); } catch (e) { /* */ }
    }, delay);
}

/**
 * Cast getter for the Present Characters bar. Reads the latest assistant
 * message's parsed NPCs Present, augments each with their NPC Bank entry
 * (for the portrait + sex tint), and de-dupes by name.
 */
function buildPresentCast() {
    try {
        const ctx = getContext();
        const found = findLastAssistantMessage(ctx?.chat);
        const parsed = found ? parseMessage(found.msg.mes) : null;
        const npcs = parsed?.worldState?.npcs || [];
        const out = [];
        const seen = new Set();
        for (const npc of npcs) {
            const name = (npc.name || "").trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const banked = (getProfile()?.npcBank?.npcs || []).find(b => {
                const bn = (b.name || "").trim().toLowerCase();
                if (!bn) return false;
                if (bn === key) return true;
                return bn.split(/\s+/)[0] === key.split(/\s+/)[0];
            }) || null;
            out.push({ name, fields: npc.fields || {}, banked });
        }
        return out;
    } catch (e) {
        return [];
    }
}

// -----------------------------------------------------------------------------
// Inline-hiding: strip the inline <details> blocks from rendered chat DOM.
// Raw chat[].mes is left intact so re-parsing on swipe/edit keeps working.
// -----------------------------------------------------------------------------
function stripInlineFromMessage(mesId) {
    const cfg = settings();
    if (!cfg.enabled || !cfg.hideInline) return;
    let root;
    if (mesId !== undefined && mesId !== null) {
        root = document.querySelector(`.mes[mesid="${mesId}"] .mes_text`);
    }
    if (!root) {
        // Fallback: scrub the most recent
        const all = document.querySelectorAll(".mes .mes_text");
        root = all[all.length - 1];
    }
    if (!root) return;

    // Walk <details> elements and remove ones whose <summary> contains our emojis
    root.querySelectorAll("details").forEach(d => {
        const sum = d.querySelector("summary");
        if (!sum) return;
        const txt = sum.textContent || "";
        if (/📌|💭|💾|🆕/.test(txt)) {
            d.style.display = "none";
            d.classList.add("meg-sp-tracker-block");
        }
    });
}

function stripInlineFromAll() {
    document.querySelectorAll(".mes .mes_text").forEach(root => {
        root.querySelectorAll("details").forEach(d => {
            const sum = d.querySelector("summary");
            if (!sum) return;
            if (/📌|💭|💾|🆕/.test(sum.textContent || "")) {
                d.style.display = settings().hideInline ? "none" : "";
                d.classList.add("meg-sp-tracker-block");
            }
        });
    });
}

// -----------------------------------------------------------------------------
// Toggling
// -----------------------------------------------------------------------------
function togglePanel(force) {
    const cfg = settings();
    const next = (typeof force === "boolean") ? !force : !cfg.collapsed;
    cfg.collapsed = next;
    persist();
    render();
}

// -----------------------------------------------------------------------------
// Wand draggability
// Lets the user drag the Megumin Suite wand button (#prompt-slot-fixed-btn)
// out of the way. Position persists in extension_settings.
// -----------------------------------------------------------------------------
const WAND_POS_KEY = "wandPosition";
const DRAG_THRESHOLD_PX = 5;

function getWandPos() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    return extension_settings[EXT_NAME][WAND_POS_KEY] || null;
}
function setWandPos(pos) {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    extension_settings[EXT_NAME][WAND_POS_KEY] = pos;
    persist();
}
function clampPos({ left, top }) {
    const w = window.innerWidth, h = window.innerHeight, btn = 48;
    return {
        left: Math.max(4, Math.min(w - btn - 4, left)),
        top: Math.max(4, Math.min(h - btn - 4, top)),
    };
}
function applyWandPos(btn, pos) {
    if (!btn || !pos) return;
    const c = clampPos(pos);
    btn.style.top = c.top + "px";
    btn.style.left = c.left + "px";
    btn.style.right = "auto";
    btn.style.bottom = "auto";
}

function setupWandDrag() {
    const tryAttach = () => {
        const btn = document.getElementById("prompt-slot-fixed-btn");
        if (!btn) return false;
        if (btn.dataset.megSpDraggable === "1") return true;
        btn.dataset.megSpDraggable = "1";

        // Restore saved position
        const saved = getWandPos();
        if (saved) applyWandPos(btn, saved);

        let dragging = false;
        let moved = false;
        let startX = 0, startY = 0, startLeft = 0, startTop = 0;
        let suppressClickUntil = 0;

        const onDown = (e) => {
            const touch = e.touches ? e.touches[0] : null;
            const cx = touch ? touch.clientX : e.clientX;
            const cy = touch ? touch.clientY : e.clientY;
            // Only respond to primary mouse button
            if (!touch && e.button !== 0) return;
            const rect = btn.getBoundingClientRect();
            startX = cx;
            startY = cy;
            startLeft = rect.left;
            startTop = rect.top;
            dragging = true;
            moved = false;
            btn.style.transition = "none";
        };
        const onMove = (e) => {
            if (!dragging) return;
            const touch = e.touches ? e.touches[0] : null;
            const cx = touch ? touch.clientX : e.clientX;
            const cy = touch ? touch.clientY : e.clientY;
            const dx = cx - startX;
            const dy = cy - startY;
            if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            moved = true;
            e.preventDefault();
            const next = clampPos({ left: startLeft + dx, top: startTop + dy });
            btn.style.left = next.left + "px";
            btn.style.top = next.top + "px";
            btn.style.right = "auto";
            btn.style.bottom = "auto";
            btn.style.cursor = "grabbing";
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            btn.style.transition = "";
            btn.style.cursor = "";
            if (moved) {
                // Persist and swallow the next click so the modal doesn't pop
                const rect = btn.getBoundingClientRect();
                setWandPos({ left: rect.left, top: rect.top });
                suppressClickUntil = Date.now() + 200;
            }
        };

        btn.addEventListener("mousedown", onDown);
        btn.addEventListener("touchstart", onDown, { passive: true });
        window.addEventListener("mousemove", onMove);
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("mouseup", onUp);
        window.addEventListener("touchend", onUp);
        window.addEventListener("touchcancel", onUp);

        // Click-suppression: capture-phase so we beat Megumin's own click handler
        btn.addEventListener("click", (e) => {
            if (Date.now() < suppressClickUntil) {
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
            }
        }, true);

        // Hint with cursor
        btn.style.cursor = "grab";
        btn.title = (btn.title || "") + " (drag to move)";

        // Keep it inside viewport if window resizes
        window.addEventListener("resize", () => {
            const cur = getWandPos();
            if (cur) applyWandPos(btn, cur);
        });
        return true;
    };

    if (tryAttach()) return;
    // The wand is injected later from jQuery; poll briefly.
    let attempts = 0;
    const id = setInterval(() => {
        attempts++;
        if (tryAttach() || attempts > 40) clearInterval(id);
    }, 250);
}

function injectStylesheet() {
    if (document.getElementById("meg-sp-styles")) return;
    const link = document.createElement("link");
    link.id = "meg-sp-styles";
    link.rel = "stylesheet";
    // Resolve URL relative to this module so it works regardless of mount path
    try {
        link.href = new URL("./styles.css", import.meta.url).toString();
    } catch (e) {
        link.href = "scripts/extensions/third-party/Megumin-Suite/src/sidepanel/styles.css";
    }
    document.head.appendChild(link);
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
export function initSidePanel({ profileGetter } = {}) {
    if (initialised) return;
    initialised = true;

    if (typeof profileGetter === "function") getProfile = profileGetter;

    injectStylesheet();
    setupWandDrag();
    initPresentBar({
        castGetter: buildPresentCast,
        onOpenInBook: (npcName) => {
            const list = getProfile()?.npcBank?.npcs || [];
            const idx = list.findIndex(n => (n.name || "").trim().toLowerCase() === (npcName || "").trim().toLowerCase());
            openNpcBook(idx >= 0 ? idx : undefined);
        },
    });

    // Build skeleton when DOM is ready
    const mount = () => {
        if (document.getElementById(PANEL_ID)) return;
        buildPanelSkeleton();
        render();
        stripInlineFromAll();
        refreshPresentBar();
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
        mount();
    }

    // Wire SillyTavern events
    if (typeof eventSource !== "undefined" && typeof event_types !== "undefined") {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
            scheduleRender(50);
            setTimeout(() => stripInlineFromMessage(mesId), 0);
        });
        eventSource.on(event_types.USER_MESSAGE_RENDERED, (mesId) => {
            setTimeout(() => stripInlineFromMessage(mesId), 0);
        });
        eventSource.on(event_types.MESSAGE_EDITED, () => scheduleRender(50));
        eventSource.on(event_types.MESSAGE_DELETED, () => scheduleRender(50));
        eventSource.on(event_types.MESSAGE_SWIPED, () => {
            scheduleRender(50);
            setTimeout(stripInlineFromAll, 50);
        });
        eventSource.on(event_types.CHAT_CHANGED, () => {
            scheduleRender(50);
            setTimeout(stripInlineFromAll, 100);
        });
        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
            setTimeout(stripInlineFromAll, 50);
        });
        eventSource.on(event_types.APP_READY, () => {
            scheduleRender(100);
            setTimeout(stripInlineFromAll, 150);
        });
    }
}

export function refreshSidePanel() { render(); }
// Re-export present bar API so the settings tab can drive it
export { getPresentBarSettings, applyPresentBarChange, refreshPresentBar };
export function getSidePanelSettings() { return settings(); }
export function applyInlineHidingChange() {
    document.body.classList.toggle(BODY_HIDE_CLASS, !!settings().hideInline);
    stripInlineFromAll();
    // Re-show if disabled
    if (!settings().hideInline) {
        document.querySelectorAll(".mes .mes_text details.meg-sp-tracker-block").forEach(d => {
            d.style.display = "";
        });
    }
}
export function applyPositionChange() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const cfg = settings();
    panel.classList.remove("meg-sp-pos-left", "meg-sp-pos-right");
    panel.classList.add("meg-sp-pos-" + cfg.position);
}
export function applyWidthChange() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.style.setProperty("--meg-sp-width", (settings().width || 360) + "px");
}
export function applyEnabledChange() {
    const panel = document.getElementById(PANEL_ID);
    const fab = document.getElementById(FAB_ID);
    const cfg = settings();
    if (panel) panel.style.display = cfg.enabled ? "" : "none";
    if (fab) fab.style.display = cfg.enabled ? "" : "none";
    document.body.classList.toggle(BODY_OPEN_CLASS, cfg.enabled && !cfg.collapsed);
    if (cfg.enabled) {
        render();
        stripInlineFromAll();
    } else {
        // Show inline blocks again when disabled
        document.querySelectorAll(".mes .mes_text details.meg-sp-tracker-block").forEach(d => {
            d.style.display = "";
        });
        document.body.classList.remove(BODY_HIDE_CLASS);
    }
}
