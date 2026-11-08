// Saved shell tasks, opened from the command palette. Definitions and runs live
// in shared state. A run is a background core terminal (no space/tab labels, so
// it is not a tab). Props: { view: "add" | "list" | "output" }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, settings, spaces, panes, focused, terminals, exec, hc, shared, setShared, notify, window as win, t as tr } from "herdr";

const DEFS = "tasks.defs";
const RUNS = "tasks.runs";
const KEEP = 40;

function rows(key) {
  const v = shared(key);
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
}

function nid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function here() {
  const space = spaces().find((s) => s.active);
  const cwd = focused()?.cwd || panes().find((p) => p.focused)?.cwd || space?.folder || "";
  return { cwd, on: space?.machine || null, space };
}

function activeSpace() {
  return spaces().find((s) => s.active) ?? null;
}

// Missing scope is global, so tasks saved before scopes still run everywhere.
function scopeKind(task) {
  return task?.scope === "space" && task.space ? "space" : "global";
}

function scopeText(task) {
  if (scopeKind(task) !== "space") return tr("tasks.scope_global");
  const current = activeSpace();
  if (current && task.space === current.id) return tr("tasks.scope_current");
  return spaces().find((s) => s.id === task.space)?.name || task.spaceName || tr("tasks.scope_space");
}

function titled(task) {
  return tr("tasks.titled", { scope: scopeText(task), name: task?.name || task?.command || "" });
}

function spacePlace(space) {
  if (!space) return { cwd: "", on: null };
  const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
  const cwd = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || "";
  return { cwd, on: space.machine || null };
}

function nameTaken(defs, task) {
  return defs.some((d) => d.id !== task.id && d.name === task.name && scopeKind(d) === task.scope && (task.scope !== "space" || d.space === task.space));
}

function liveOf(taskId) {
  const live = new Set(liveTerms().map((t) => t.address));
  return rows(RUNS).find((r) => r.taskId === taskId && r.status === "running" && r.terminal && live.has(r.terminal)) ?? null;
}

function runName(item) {
  const def = rows(DEFS).find((d) => d.id === item.taskId);
  return titled(def || item);
}

// The running popup keeps one row per displayed name. A rerun must not stack another line.
function shownRuns() {
  const live = new Set(liveTerms().map((t) => t.address));
  const groups = new Map();
  for (const item of rows(RUNS)) {
    const key = runName(item);
    const on = item.status === "running" && item.terminal && live.has(item.terminal);
    const prev = groups.get(key);
    if (!prev) groups.set(key, { item, on, ids: [item.id] });
    else {
      prev.ids.push(item.id);
      if (on && !prev.on) { prev.item = item; prev.on = true; }
    }
  }
  return [...groups.values()];
}

function liveTerms() {
  return terminals().filter((t) => t.state === "live");
}

function machineOf(address) {
  const i = address ? address.lastIndexOf("/") : -1;
  return i > 0 ? address.slice(0, i) : null;
}

function reconcile(runs, live) {
  let changed = false;
  const next = runs.map((r) => {
    if (r.status === "running" && r.terminal && !live.has(r.terminal)) {
      changed = true;
      return { ...r, status: "stopped" };
    }
    return r;
  });
  return changed ? next : runs;
}

// A terminal we started and then lost the record for (crash between hc and save).
function absorb(runs, live) {
  const known = new Set(runs.map((r) => r.id));
  const defs = rows(DEFS);
  const extra = [];
  for (const t of live) {
    const runId = t.labels?.["herdr.run"];
    if (!runId || known.has(runId)) continue;
    const taskId = t.labels?.["herdr.task"] || "";
    const def = defs.find((d) => d.id === taskId);
    extra.push({
      id: runId,
      taskId,
      name: def?.name || taskId || runId,
      command: def?.command || "",
      cwd: t.cwd || def?.cwd || "",
      on: machineOf(t.address),
      terminal: t.address,
      status: "running",
      started: Date.now(),
    });
  }
  return extra.length ? [...extra, ...runs] : runs;
}

function remember(runs, rec) {
  const next = [rec, ...runs.filter((r) => r.id !== rec.id)];
  const running = next.filter((r) => r.status === "running");
  const stopped = next.filter((r) => r.status !== "running");
  return [...running, ...stopped].slice(0, KEEP);
}

function failText(r) {
  const raw = `${r?.stderr || ""}\n${r?.stdout || ""}`.trim();
  try {
    const j = JSON.parse(r?.stdout || r?.stderr || "");
    const err = j?.error;
    if (typeof err === "string" && err) return err;
    if (err?.message) return err.message;
  } catch { /* hc sometimes prints plain text */ }
  return raw || tr("tasks.failed");
}

async function shellPrefix(on) {
  if (!on && win()?.platform === "windows") return ["powershell.exe", "-NoProfile", "-Command"];
  let shell = "/bin/sh";
  try {
    const r = on
      ? await exec("sh", ["-c", 'printf %s "$SHELL"'], { on })
      : await exec("printenv", ["SHELL"]);
    const s = (r.stdout || "").trim();
    if (r.code === 0 && s && !s.includes("\n") && !s.includes("\0")) shell = s;
  } catch { /* fall back to sh -c */ }
  return [shell, "-c"];
}

async function spawn(task, cwd, on) {
  const runId = nid();
  const prefix = await shellPrefix(on);
  // Keep the terminal after it exits so 打开 can still read what it printed.
  const args = ["run", "--json", "--bg", "--no-parent", "--no-notify", "--label", `herdr.task=${task.id}`, "--label", `herdr.run=${runId}`];
  if (cwd) args.push("--cwd", cwd);
  if (on) args.push("--on", on);
  args.push("--", ...prefix, task.command);
  const r = await hc(args);
  if (!r || r.code !== 0) throw new Error(failText(r));
  let address = "";
  try { address = JSON.parse(r.stdout).address || ""; } catch { /* parsed below */ }
  if (!address) {
    const m = /"address"\s*:\s*"([^"]+)"/.exec(r.stdout || "");
    address = m ? m[1] : "";
  }
  if (!address) throw new Error(failText(r));
  return {
    id: runId,
    taskId: task.id,
    name: task.name,
    command: task.command,
    cwd: cwd || "",
    on: on || null,
    terminal: address,
    status: "running",
    started: Date.now(),
    scope: task.scope || "global",
    space: task.space || null,
    spaceName: task.spaceName || "",
  };
}

export default class Tasks extends View {
  init(_props, cx) {
    const view = props()?.view;
    this.view = view === "add" || view === "running" || view === "output" ? view : "list";
    this.form = this.view === "add";
    this.back = null;
    this.editing = null;
    this.name = "";
    this.command = "";
    this.cwd = "";
    this.scope = activeSpace() ? "space" : "global";
    this.space = activeSpace()?.id ?? null;
    this.spaceName = activeSpace()?.name ?? "";
    this.error = "";
    this.busy = false;
    this.at = 0;
    this.col = 0;
    this.filter = "all";
    this.tails = {};
    this.output = "";
    this.outputError = "";
    this.outputReady = false;
    this.formAt = 0;
    this.buttonAt = 2;
    this.handle = cx.focus_handle();
    if (this.form) this.ensureInputs();
    if (this.view === "output") {
      this.outputTerminal = props()?.terminal;
      this.outputTitle = props()?.title || "";
      this.loadOutput(cx);
      cx.timer.every(1000, (cx) => {
        if (this.outputTerminal && liveTerms().some((t) => t.address === this.outputTerminal)) this.loadOutput(cx);
      });
    }
    const focus = () => { if (this.form) this.focusForm(); else this.handle.focus(); };
    focus();
    // The dialog frame takes the keyboard as it opens; take it back once that settles.
    cx.timer.after(600, focus);
  }

  ensureInputs() {
    if (this.nameInput) return;
    const bind = (input, key) => {
      input.on("change", (_e, cx) => { this[key] = input.value(); this.error = ""; cx.notify(); });
      input.on("focus", (_e, cx) => { this.focus = key; this.formAt = { name: 0, command: 1, cwd: 2 }[key]; cx.notify(); });
      input.on("blur", (_e, cx) => { if (this.focus === key) this.focus = ""; cx.notify(); });
    };
    this.nameInput = InputState.new({ value: this.name, placeholder: tr("tasks.name_ph") });
    this.cmdInput = InputState.new({ value: this.command, placeholder: tr("tasks.command_ph") });
    this.cwdInput = InputState.new({ value: this.cwd, placeholder: here().cwd || tr("tasks.cwd_ph") });
    bind(this.nameInput, "name");
    bind(this.cmdInput, "command");
    bind(this.cwdInput, "cwd");
    this.cmdInput.on("submit", (_e, cx) => this.save(true, cx));
    this.nameInput.focus();
  }

  syncRuns() {
    const saved = rows(RUNS);
    const live = liveTerms();
    const ids = new Set(live.map((t) => t.address));
    let next = reconcile(saved, ids);
    const absorbed = absorb(next, live);
    if (absorbed !== next) next = absorbed;
    if (next !== saved) setShared(RUNS, next);
  }

  cancel(cx) {
    this.error = "";
    if (this.back) {
      this.back = null;
      this.editing = null;
      this.form = false;
      this.view = "list";
      this.handle.focus();
      cx.notify();
      return;
    }
    closeOverlay(props().overlay);
  }

  save(andRun, cx) {
    const name = this.name.trim();
    const command = this.command.trim();
    const cwd = this.cwd.trim();
    if (!name || !command) {
      this.error = tr("tasks.need_name_command");
      cx.notify();
      return;
    }
    const task = this.taskFromForm(name, command, cwd);
    if (!task) { cx.notify(); return; }
    const defs = rows(DEFS);
    if (nameTaken(defs, task)) {
      this.error = tr("tasks.name_taken");
      cx.notify();
      return;
    }
    setShared(DEFS, this.editing ? defs.map((d) => (d.id === task.id ? task : d)) : [...defs, task]);
    if (!andRun) {
      this.afterSave(cx);
      return;
    }
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.start(task);
        this.afterSave(cx);
      } catch (e) {
        this.busy = false;
        this.error = e?.message || String(e);
        cx.notify();
      }
    });
  }

  afterSave(cx) {
    this.busy = false;
    if (this.back) {
      this.back = null;
      this.editing = null;
      this.form = false;
      this.view = "list";
      this.handle.focus();
      cx.notify();
      return;
    }
    closeOverlay(props().overlay);
  }

  taskFromForm(name, command, cwd) {
    const scope = this.scope === "space" ? "space" : "global";
    let space = null;
    let spaceName = "";
    if (scope === "space") {
      const bound = this.space && spaces().find((s) => s.id === this.space);
      const target = bound || activeSpace();
      if (!target) { this.error = tr("tasks.need_space"); return null; }
      space = target.id;
      spaceName = target.name;
    }
    return { id: this.editing || nid(), name, command, cwd, scope, space, spaceName };
  }

  // One live task at a time: a new start stops whatever is still running.
  stopLive() {
    const live = new Set(liveTerms().map((t) => t.address));
    let changed = false;
    const next = rows(RUNS).map((r) => {
      if (r.status !== "running") return r;
      if (r.terminal && live.has(r.terminal)) run("terminal.kill", { terminal: r.terminal });
      changed = true;
      return { ...r, status: "stopped" };
    });
    if (changed) setShared(RUNS, next);
  }

  async start(task, again) {
    this.stopLive();
    const place = scopeKind(task) === "space" ? spacePlace(spaces().find((s) => s.id === task.space)) : here();
    const cwd = again ? (again.cwd || "") : (task.cwd || place.cwd);
    const on = again ? (again.on ?? null) : place.on;
    const rec = await spawn(task, cwd, on);
    setShared(RUNS, remember(rows(RUNS), rec));
  }

  edit(def, cx) {
    this.editing = def.id;
    this.name = def.name || "";
    this.command = def.command || "";
    this.cwd = def.cwd || "";
    if (!def.id) {
      const current = activeSpace();
      this.scope = current ? "space" : "global";
      this.space = current?.id ?? null;
      this.spaceName = current?.name ?? "";
    } else {
      this.scope = scopeKind(def);
      this.space = def.space || null;
      this.spaceName = def.spaceName || "";
    }
    this.error = "";
    this.ensureInputs();
    this.form = true;
    this.formAt = 0;
    this.back = "list";
    this.nameInput.set_value(this.name);
    this.cmdInput.set_value(this.command);
    this.cwdInput.set_value(this.cwd);
    this.nameInput.focus();
    cx.notify();
  }

  removeDef(id) {
    setShared(DEFS, rows(DEFS).filter((d) => d.id !== id));
  }

  launch(task, cx, openAfter) {
    if (this.busy) return;
    this.busy = task.id;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.start(task);
        if (openAfter) {
          const live = liveOf(task.id);
          if (live) this.openRun(live, cx);
        }
      } catch (e) { notify({ title: tr("tasks.failed"), body: e?.message || String(e), level: "error" }); }
      this.busy = false;
      cx.notify();
    });
  }

  rerun(item, cx) {
    const task = rows(DEFS).find((d) => d.id === item.taskId) || { id: item.taskId || nid(), name: item.name, command: item.command, cwd: item.cwd };
    if (!task.command) {
      notify({ title: tr("tasks.no_command"), level: "error" });
      return;
    }
    if (this.busy) return;
    this.busy = item.id;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.start({ ...task, name: item.name || task.name }, item);
        const live = liveOf(task.id);
        if (live) this.openRun(live, cx);
      } catch (e) { notify({ title: tr("tasks.failed"), body: e?.message || String(e), level: "error" }); }
      this.busy = false;
      cx.notify();
    });
  }

  stop(item) {
    if (item.terminal && liveTerms().some((t) => t.address === item.terminal)) run("terminal.kill", { terminal: item.terminal });
    setShared(RUNS, rows(RUNS).map((r) => (r.id === item.id ? { ...r, status: "stopped" } : r)));
  }

  removeRun(item) {
    const ids = new Set(shownRuns().find((g) => g.ids.includes(item.id))?.ids ?? [item.id]);
    const live = new Set(liveTerms().map((t) => t.address));
    for (const r of rows(RUNS)) {
      if (ids.has(r.id) && r.status === "running" && r.terminal && live.has(r.terminal)) run("terminal.kill", { terminal: r.terminal });
    }
    setShared(RUNS, rows(RUNS).filter((r) => !ids.has(r.id)));
  }

  openRun(item, _cx) {
    if (!item.terminal) {
      notify({ title: tr("tasks.open_failed"), body: tr("tasks.no_terminal"), level: "error" });
      return;
    }
    // Leave the list open underneath. Esc closes only this dialog, then the list is focused again.
    setShared("tasks.cover", item.terminal);
    openOverlay({
      mod: "tasks",
      kind: "dialog",
      width: 0.92,
      height: 0.88,
      props: { view: "output", terminal: item.terminal, title: runName(item) },
    });
  }

  async close() {
    if (props()?.view === "output") setShared("tasks.cover", null);
  }

  loadOutput(cx) {
    const terminal = this.outputTerminal || props()?.terminal;
    this.output = "";
    this.outputError = "";
    this.outputReady = false;
    if (!terminal) { this.outputError = tr("tasks.no_terminal"); this.outputReady = true; return; }
    cx.spawn(async (cx) => {
      const r = await hc(["read", terminal, "--lines", "200"]).catch((e) => ({ code: 1, stderr: String(e), stdout: "" }));
      if (!r || r.code !== 0) this.outputError = failText(r);
      else this.output = r.stdout || "";
      this.outputReady = true;
      cx.notify();
    });
  }

  loadTails(cx) {
    for (const group of shownRuns()) {
      const addr = group.item.terminal;
      if (!addr || this.tails[addr] !== undefined) continue;
      this.tails[addr] = null;
      cx.spawn(async (cx) => {
        const r = await hc(["read", addr, "--lines", "20"]).catch(() => null);
        const text = r && r.code === 0 ? r.stdout : "";
        this.tails[addr] = text.split("\n").map((s) => s.trimEnd()).filter((s) => s.trim()).pop() || "";
        cx.notify();
      });
    }
  }

  plain(e) {
    const m = e.modifiers ?? {};
    return !m.control && !m.platform && !m.alt;
  }

  clamp(slots) {
    if (!slots.length) { this.at = 0; this.col = 0; return; }
    if (this.at < 0 || this.at >= slots.length) this.at = Math.max(0, Math.min(this.at, slots.length - 1));
    const n = slots[this.at].cols.length;
    if (this.col < 0 || this.col >= n) this.col = Math.max(0, Math.min(this.col, n - 1));
  }

  move(slots, key) {
    this.clamp(slots);
    const row = slots[this.at];
    if (!row) return false;
    if (key === "down") this.at = Math.min(this.at + 1, slots.length - 1);
    else if (key === "up") this.at = Math.max(this.at - 1, 0);
    else if (key === "right") this.col = Math.min(this.col + 1, row.cols.length - 1);
    else if (key === "left") this.col = Math.max(this.col - 1, 0);
    else return false;
    this.clamp(slots);
    return true;
  }

  pick(slots, cx) {
    this.clamp(slots);
    slots[this.at]?.cols[this.col]?.run(cx);
  }

  focusForm() {
    if (!this.nameInput) return;
    const fields = [this.nameInput, this.cmdInput, this.cwdInput];
    if (this.formAt < 3) {
      this.focus = ["name", "command", "cwd"][this.formAt];
      fields[this.formAt].focus();
    } else {
      this.focus = "";
      this.handle.focus();
    }
  }

  pickScope(kind, rebind = false) {
    if (kind !== "space") { this.scope = "global"; this.error = ""; return; }
    const current = activeSpace();
    if ((rebind || this.scope !== "space" || !this.space) && current) {
      this.space = current.id;
      this.spaceName = current.name;
    }
    if (!this.space && !current) { this.error = tr("tasks.need_space"); return; }
    this.scope = "space";
    this.error = "";
  }

  formKey(e, cx) {
    const k = e.key;
    if (k === "up" || k === "down") {
      this.formAt = k === "down" ? Math.min(this.formAt + 1, 4) : Math.max(this.formAt - 1, 0);
      this.focusForm();
    } else if ((k === "left" || k === "right") && this.formAt === 3) {
      this.pickScope(k === "left" ? "space" : "global");
    } else if ((k === "left" || k === "right") && this.formAt === 4) {
      this.buttonAt = k === "right" ? Math.min(this.buttonAt + 1, 2) : Math.max(this.buttonAt - 1, 0);
    } else if (k === "enter" && this.formAt === 4 && !this.busy) {
      [((c) => this.cancel(c)), ((c) => this.save(false, c)), ((c) => this.save(true, c))][this.buttonAt](cx);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.view === "output" && props()?.view !== "output") {
        this.view = "list";
        this.handle.focus();
        cx.stop_propagation();
        cx.notify();
        return;
      }
      this.cancel(cx);
      cx.stop_propagation();
      return;
    }
    if (this.view === "output" || !this.plain(e)) return;
    if (this.form) return this.formKey(e, cx);
    const slots = this.view === "running" ? this.runSlots() : this.defSlots();
    if (!slots.length) return;
    if (e.key === "enter") this.pick(slots, cx);
    else if (!this.move(slots, e.key)) return;
    if (this.view === "list" && this.at === 0 && (e.key === "left" || e.key === "right")) {
      this.filter = this.col === 0 ? "all" : "running";
    }
    cx.stop_propagation();
    cx.notify();
  }

  button(id, text, primary, action, enabled = true, hot = false) {
    const t = theme();
    const on = enabled && !this.busy;
    return h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(hot || (primary && on) ? t.accent : t.input).bg(primary && on ? t.solid : hot ? t.selected : t.raised)
      .text_color(on ? (primary ? t.solid_foreground : t.foreground) : t.dim).text_size(12.5).font_medium()
      .when(on, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (on) { this.formAt = 4; this.buttonAt = id === "tasks-cancel" ? 0 : id === "tasks-save" ? 1 : 2; action(cx); } })
      .child(text);
  }

  act(id, text, hot, action) {
    const t = theme();
    return div().id(id).px(6).h(22).flex().items_center().rounded(5).text_size(11.5)
      .text_color(hot ? t.foreground : t.muted).cursor_pointer()
      .border_1().border_color(hot ? t.accent : t.popover).bg(hot ? t.selected : t.popover)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(text);
  }

  listed() {
    const defs = rows(DEFS);
    if (this.filter !== "running") return defs;
    return defs.filter((d) => liveOf(d.id));
  }

  setFilter(kind, cx) {
    this.filter = kind === "running" ? "running" : "all";
    this.at = 0;
    this.col = this.filter === "running" ? 1 : 0;
    if (cx) cx.notify();
  }

  defSlots() {
    const defs = this.listed();
    return [
      { cols: [{ run: (cx) => this.setFilter("all", cx) }, { run: (cx) => this.setFilter("running", cx) }] },
      { cols: [{ run: (cx) => this.edit({ id: null, name: "", command: "", cwd: "" }, cx) }] },
      ...defs.map((d) => {
        const live = liveOf(d.id);
        return live
          ? { cols: [
            { run: (cx) => this.openRun(live, cx) },
            { run: (cx) => this.rerun(live, cx) },
            { run: () => this.stop(live) },
          ] }
          : { cols: [
            { run: (cx) => this.launch(d, cx, true) },
            { run: (cx) => this.edit(d, cx) },
            { run: () => this.removeDef(d.id) },
          ] };
      }),
    ];
  }

  runSlots() {
    return shownRuns().map(({ item, on }) => {
      const cols = [{ run: () => this.openRun(item) }, { run: (cx) => this.rerun(item, cx) }];
      if (on) cols.push({ run: () => this.stop(item) });
      cols.push({ run: () => this.removeRun(item) });
      return { cols, on };
    });
  }

  field(label, input, key) {
    const t = theme();
    return v_flex()
      .child(div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(label))
      .child(Input.new(input).h(36).px(10).rounded(9).border_1().border_color(this.focus === key ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground));
  }

  formView() {
    const t = theme();
    const title = this.editing ? tr("tasks.title_edit") : tr("tasks.title_add");
    return v_flex().id("tasks-add").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(title))
        .child(div().text_size(11).text_color(t.dim).child(tr("tasks.key_form"))))
      .child(this.field(tr("tasks.name"), this.nameInput, "name"))
      .child(this.field(tr("tasks.command"), this.cmdInput, "command"))
      .child(this.field(tr("tasks.cwd"), this.cwdInput, "cwd"))
      .child(this.scopeRow(t))
      .child(div().pt(8).text_size(11.5).text_color(t.dim).child(tr("tasks.hint")))
      .when(Boolean(this.error), (el) => el.child(div().pt(8).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(18).gap(8).justify_end()
        .child(this.button("tasks-cancel", tr("action.cancel"), false, (cx) => this.cancel(cx), true, this.formAt === 4 && this.buttonAt === 0))
        .child(this.button("tasks-save", tr("action.save"), false, (cx) => this.save(false, cx), true, this.formAt === 4 && this.buttonAt === 1))
        .child(this.button("tasks-save-run", this.busy === true ? tr("tasks.starting") : tr("tasks.save_run"), true, (cx) => this.save(true, cx), true, this.formAt === 4 && this.buttonAt === 2)));
  }

  scopeRow(t) {
    const hot = this.formAt === 3;
    const chip = (id, kind, label) => {
      const on = this.scope === kind;
      return h_flex().id(id).h(28).px(10).items_center().rounded(7).text_size(12).cursor_pointer()
        .border_1().border_color(on ? t.accent : hot ? t.input : t.border).bg(on ? t.selected : t.raised).text_color(t.foreground)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.formAt = 3; this.pickScope(kind, true); this.handle.focus(); cx.notify(); })
        .child(label);
    };
    const bound = this.scope === "space" ? (spaces().find((s) => s.id === this.space)?.name || this.spaceName) : "";
    return v_flex()
      .child(div().pt(14).pb(6).text_size(11.5).text_color(hot ? t.foreground : t.dim).child(tr("tasks.scope")))
      .child(h_flex().gap(8)
        .child(chip("tasks-scope-space", "space", tr("tasks.scope_current")))
        .child(chip("tasks-scope-global", "global", tr("tasks.scope_global"))))
      .when(Boolean(bound), (el) => el.child(div().pt(6).text_size(11.5).text_color(t.dim).child(tr("tasks.scope_saved", { name: bound }))));
  }

  listView() {
    const t = theme();
    const defs = this.listed();
    const slots = this.defSlots();
    this.clamp(slots);
    const mark = (row, col, cx) => { this.at = row; this.col = col; cx.notify(); };
    const filterChip = (id, kind, label) => {
      const on = this.filter === kind;
      const hot = this.at === 0 && ((kind === "all" && this.col === 0) || (kind === "running" && this.col === 1));
      return h_flex().id(id).h(26).px(8).items_center().rounded(6).text_size(12).cursor_pointer()
        .border_1().border_color(on || hot ? t.accent : t.border).bg(on ? t.selected : t.raised).text_color(t.foreground)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.setFilter(kind, cx))
        .child(label);
    };
    const row = (d, i) => {
      const at = i + 2;
      const on = this.at === at;
      const live = liveOf(d.id);
      const actions = live
        ? [
          [tr("tasks.open"), 0, (cx) => { mark(at, 0, cx); this.openRun(live, cx); }],
          [tr("tasks.rerun"), 1, (cx) => { mark(at, 1, cx); this.rerun(live, cx); }],
          [tr("tasks.stop"), 2, (cx) => { mark(at, 2, cx); this.stop(live); }],
        ]
        : [
          [tr("tasks.run"), 0, (cx) => { mark(at, 0, cx); this.launch(d, cx, true); }],
          [tr("tasks.edit"), 1, (cx) => { mark(at, 1, cx); this.edit(d, cx); }],
          [tr("tasks.delete"), 2, (cx) => { mark(at, 2, cx); this.removeDef(d.id); }],
        ];
      return h_flex().id(`task-${d.id}`).px(8).py(8).gap(8).rounded(8).items_center()
        .bg(on ? t.selected : t.popover).hover((s) => s.bg(t.hover))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(13).text_color(t.foreground).truncate().child(titled(d)))
          .child(div().text_size(11.5).text_color(t.dim).truncate().child(live ? tr("tasks.running") : d.command)))
        .children(actions.map(([label, col, action]) => this.act(`${d.id}-${col}`, label, on && this.col === col, action)));
    };
    return v_flex().id("tasks-list").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().p(14).bg(t.popover).text_color(t.foreground)
      .child(h_flex().px(4).pb(8).gap(8).items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(tr("tasks.title_list")))
        .child(filterChip("tasks-filter-all", "all", tr("tasks.filter_all")))
        .child(filterChip("tasks-filter-running", "running", tr("tasks.filter_running"))))
      .child(h_flex().px(4).pb(6).items_center()
        .child(this.act("tasks-new", tr("tasks.title_add"), this.at === 1, (cx) => { mark(1, 0, cx); this.edit({ id: null, name: "", command: "", cwd: "" }, cx); }))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(tr("tasks.key_list"))))
      .child(defs.length
        ? v_flex().max_h(360).overflow_y_scrollbar().children(defs.map(row))
        : div().px(4).py(16).text_size(12.5).text_color(t.dim).child(this.filter === "running" ? tr("tasks.empty_running") : tr("tasks.empty_list")));
  }

  runningView() {
    this.syncRuns();
    const t = theme();
    const items = shownRuns();
    const slots = this.runSlots();
    this.clamp(slots);
    const mark = (row, col, cx) => { this.at = row; this.col = col; cx.notify(); };
    const row = (group, i) => {
      const item = group.item;
      const running = group.on;
      const on = this.at === i;
      const label = runName(item);
      const status = running ? tr("tasks.running") : tr("tasks.stopped");
      const tail = item.terminal ? this.tails?.[item.terminal] : "";
      const stopAt = 2;
      const dropAt = running ? 3 : 2;
      return h_flex().id(`run-${item.id}`).px(8).py(7).gap(8).rounded(8).items_center()
        .bg(on ? t.selected : t.popover).hover((s) => s.bg(t.hover))
        .child(running
          ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900)
          : div().size(6).mx(3).rounded(3).flex_none().bg(t.dim))
        .child(v_flex().flex_1().min_w(0).gap(2).cursor_pointer()
          .border_1().border_color(on && this.col === 0 ? t.accent : t.popover).rounded(5).px(4)
          .on_click((_e, cx) => { mark(i, 0, cx); this.openRun(item); })
          .child(div().text_size(13).text_color(running ? t.foreground : t.muted).truncate().child(label))
          .child(div().text_size(11.5).text_color(t.dim).truncate().child(tail ? `${status} · ${tail}` : status)))
        .child(this.act(`open-${item.id}`, tr("tasks.open"), on && this.col === 0, (cx) => { mark(i, 0, cx); this.openRun(item); }))
        .child(this.act(`rerun-${item.id}`, tr("tasks.rerun"), on && this.col === 1, (cx) => { mark(i, 1, cx); this.rerun(item, cx); }))
        .when(running, (el) => el.child(this.act(`stop-${item.id}`, tr("tasks.stop"), on && this.col === stopAt, (cx) => { mark(i, stopAt, cx); this.stop(item); })))
        .child(this.act(`drop-${item.id}`, tr("tasks.delete"), on && this.col === dropAt, (cx) => { mark(i, dropAt, cx); this.removeRun(item); }));
    };
    return v_flex().id("tasks-running").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().p(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().px(6).pt(4).pb(8).items_center()
        .child(div().flex_1().text_size(12).font_semibold().text_color(t.muted).child(tr("tasks.title_running")))
        .child(div().text_size(11).text_color(t.dim).child(tr("tasks.key_list"))))
      .child(items.length
        ? v_flex().max_h(360).overflow_y_scrollbar().children(items.map(row))
        : div().px(6).py(12).text_size(12.5).text_color(t.dim).child(tr("tasks.empty_running")));
  }

  outputView() {
    const t = theme();
    const title = this.outputTitle || props()?.title || tr("tasks.output_title");
    const live = this.outputTerminal && liveTerms().some((t) => t.address === this.outputTerminal);
    const lines = this.outputError ? [this.outputError] : !this.outputReady ? [tr("tasks.output_loading")] : (this.output || tr("tasks.output_empty")).split("\n");
    const font = settings();
    const family = font.font_family || "JetBrains Mono";
    const size = font.font_size || 14;
    return v_flex().id("tasks-output").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(14).gap(8).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().min_w(0).text_size(15).font_semibold().truncate().child(title))
        .child(div().text_size(12).text_color(live ? t.working : t.dim).child(live ? tr("tasks.running") : tr("tasks.stopped")))
        .child(div().text_size(11).text_color(t.dim).child(tr("tasks.back_list"))))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(8).rounded(8).bg(t.background)
        .children(lines.slice(-400).map((line, i) => div().id(`out-${i}`).font_family(family).text_size(size).line_height(`${size}px`).text_color(this.outputError ? t.blocked : t.foreground).child(line || " "))));
  }

  render(cx) {
    // focus() is illegal during render. Schedule it once the cover dialog has gone.
    if (this.view === "list" && this.covered && !shared("tasks.cover") && cx && !this.refocus) {
      this.refocus = true;
      cx.timer.after(16, (cx) => { this.refocus = false; this.handle.focus(); });
    }
    this.covered = Boolean(shared("tasks.cover"));
    if (this.view === "output") return this.outputView();
    if (this.form) return this.formView();
    if (this.view === "running") {
      if (cx) this.loadTails(cx);
      return this.runningView();
    }
    return this.listView();
  }
}
