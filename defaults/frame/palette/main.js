// The frame's command palette: everything you can do, by name, with its key.
// Places (spaces, tabs) stay in the picker. Fuzzy: your letters in
// order, word starts and runs rank higher. Empty: recent first, then every
// group. Choices are entries of their own ("Layout: Zen"); commands that need
// a name ask for it. Enter runs, ↑/↓ move, Esc closes.
// The app's own mod: rewritten from the binary on every start.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { commands, layouts, keys, run, theme, props, closeOverlay, openOverlay, shared, window as win, t as tr } from "herdr";

// The list keeps one height while you move: rows and group titles have fixed
// heights, and the window shows as many as fit in LIST_H.
// 10 rows: with the search line it fits the popup (at most 85% of the
// window) down to ~580 px windows at zoom 1.3.
const SHOWN = 10;
const ROW_H = 32;
const HEAD_H = 26;
const LIST_H = SHOWN * ROW_H;

function groups() {
  return [
    tr("palette.group.recent"),
    tr("palette.group.tab"),
    tr("palette.group.pane"),
    tr("palette.group.space"),
    tr("palette.group.layout"),
    tr("palette.group.terminal"),
    tr("palette.group.agent"),
    tr("palette.group.window"),
    tr("palette.group.app"),
  ];
}

// The palette's names for commands: [command, args, group, title, keywords].
// Keywords keep the English words and add Chinese, so search works in either language.
function named() {
  const [, Tab, Pane, Space, Layout, Terminal, Agent, Window, App] = groups();
  const dir = (d) => tr(`palette.dir.${d}`);
  const toward = { left: "左 左侧", right: "右 右侧", up: "上 上方", down: "下 下方" };
  return [
    ["tab.new", {}, Tab, tr("palette.cmd.new_tab"), "new tab tab agent new task 标签 智能体 新建 任务"],
    ["mod.open", { name: "picker" }, Tab, tr("palette.cmd.go_to"), "go to space or tab switch jump find 前往 空间 标签 切换 跳转 查找"],
    ["tab.rename", {}, Tab, tr("palette.cmd.rename_tab"), "rename tab tab 标签 重命名"],
    ["tab.close", {}, Tab, tr("palette.cmd.close_tab"), "close tab tab kill 标签 关闭"],
    ["tab.next", {}, Tab, tr("palette.cmd.next_tab"), "next tab tab 标签 下一个"],
    ["tab.prev", {}, Tab, tr("palette.cmd.prev_tab"), "previous tab tab 标签 上一个"],
    ["pane.split", { direction: "right" }, Pane, tr("palette.cmd.split_right"), "split right vertical 向右 拆分 分割 垂直 窗格"],
    ["pane.split", { direction: "down" }, Pane, tr("palette.cmd.split_down"), "split down horizontal 向下 拆分 分割 水平 窗格"],
    ["pane.close", {}, Pane, tr("palette.cmd.close_pane"), "close pane kill 关闭 窗格"],
    ["pane.zoom", {}, Pane, tr("palette.cmd.zoom_pane"), "zoom pane maximize fullscreen 放大 最大化 全屏 窗格"],
    ...["left", "right", "up", "down"].map((d) => ["pane.go", { direction: d }, Pane, tr("palette.focus_pane", { direction: dir(d) }), `focus pane ${d} move go 聚焦 移动 窗格 ${toward[d]}`]),
    ...["left", "right", "up", "down"].map((d) => ["pane.swap", { direction: d }, Pane, tr("palette.swap_pane", { direction: dir(d) }), `swap pane ${d} move 交换 移动 窗格 ${toward[d]}`]),
    ["space.new", {}, Space, tr("palette.cmd.new_space"), "new space workspace 新建 空间 工作区"],
    ["space.rename", {}, Space, tr("palette.cmd.rename_space"), "rename space workspace 重命名 空间 工作区"],
    ["space.close", {}, Space, tr("palette.cmd.close_space"), "close space workspace kill 关闭 空间 工作区"],
    ["space.next", {}, Space, tr("palette.cmd.next_space"), "next space workspace 下一个 空间 工作区"],
    ["space.prev", {}, Space, tr("palette.cmd.prev_space"), "previous space workspace 上一个 空间 工作区"],
    ["layout.switch", {}, Layout, tr("palette.cmd.next_layout"), "next layout look switch 下一个 布局 外观 切换"],
    ["layout.reset", {}, Layout, tr("palette.cmd.reset_layout"), "reset layout new version default restore herdr's 重置 布局 默认 恢复"],
    ["layout.clone", {}, Layout, tr("palette.cmd.duplicate_layout"), "duplicate layout clone copy customize 复制 布局 克隆 自定义"],
    ["mod.clone", {}, Layout, tr("palette.cmd.duplicate_mod"), "duplicate mod clone copy customize 复制 模组 克隆 自定义"],
    ["terminal.open", {}, Terminal, tr("palette.cmd.new_terminal"), "new terminal shell 新建 终端"],
    ["terminal.copy", {}, Terminal, tr("palette.cmd.copy"), "copy clipboard 复制 剪贴板"],
    ["terminal.paste", {}, Terminal, tr("palette.cmd.paste"), "paste clipboard 粘贴 剪贴板"],
    ["agent.next", {}, Agent, tr("palette.cmd.next_agent"), "next agent 下一个 智能体"],
    ["agent.prev", {}, Agent, tr("palette.cmd.prev_agent"), "previous agent 上一个 智能体"],
    ["window.minimize", {}, Window, tr("palette.cmd.minimize"), "minimize window 最小化 窗口"],
    ["window.maximize", {}, Window, tr("palette.cmd.maximize"), "maximize window restore 最大化 窗口 还原"],
    ["window.close", {}, Window, tr("palette.cmd.close_window"), "close window quit 关闭 窗口 退出"],
    ["app.settings", {}, App, tr("menu.settings"), "settings preferences options config look font theme sound 设置 偏好 选项 配置 外观 字体 主题 声音"],
    ["app.help", {}, App, tr("palette.cmd.keys"), "keys keybindings shortcuts help 快捷键 按键 帮助"],
    ["app.welcome", {}, App, tr("palette.cmd.welcome"), "welcome intro start onboarding 欢迎 介绍 开始 引导"],
    ["app.whats_new", {}, App, tr("palette.cmd.whats_new"), "what's new release changes news update 更新说明 更新 发布"],
    ["app.reset", {}, App, tr("palette.cmd.reset_screen"), "reset to the default screen escape hatch broken restore 恢复 默认 界面"],
    ["app.zoom_in", {}, App, tr("palette.cmd.zoom_in"), "zoom in bigger font size 放大 更大 字体"],
    ["app.zoom_out", {}, App, tr("palette.cmd.zoom_out"), "zoom out smaller font size 缩小 更小 字体"],
    ["app.zoom_reset", {}, App, tr("palette.cmd.zoom_reset"), "reset zoom font size 重置 缩放 字体"],
    ["app.quit", {}, App, tr("menu.quit"), "quit herdr exit 退出"],
    ...["graphite", "ink", "moss", "atom-one-dark"].map((n) => ["app.theme", { name: n }, App, tr("palette.theme_named", { name: n.replace(/-/g, " ") }), `colors look theme ${n} theme: ${n.replace(/-/g, " ")} 颜色 外观 主题`]),
  ];
}

// Commands that act on something you point at (ids, terminals): not for a list.
const HIDDEN = new Set([
  "space.move", "tab.move", "space.select", "tab.select", "pane.focus", "terminal.keep",
  "terminal.park", "terminal.kill", "terminal.show", "agent.focus", "layout.set", "layout.toggle",
  "layout.show", "layout.hide", "layout.resize", "layout.select", "mod.open", "overlay.close",
  "tab.settle", "tab.unsettle",
  "app.palette", "app.hide", "app.hide_others", "app.show_all", "app.theme", "app.settings",
]);

function titleOf(name) {
  const [noun, verb] = name.split(".");
  return { group: noun.charAt(0).toUpperCase() + noun.slice(1), title: `${verb.replace(/_/g, " ")} ${noun}`.replace(/^./, (c) => c.toUpperCase()) };
}

// Every entry for the state we're in now.
function entries() {
  const NAMED = named();
  const known = new Set(commands().map((c) => c.name));
  const mac = win()?.platform === "macos";
  const list = NAMED.filter(([n]) => known.has(n))
    .filter(([n]) => !(mac && n.startsWith("window.")))
    .map(([name, args, group, title, words]) => ({ name, args, group, title, words }));
  for (const l of layouts()) {
    const label = { main: "Herdr", terminals: tr("palette.layout.terminals"), win98: "Herdr 98" }[l] ?? l.charAt(0).toUpperCase() + l.slice(1);
    const english = { main: "Herdr", terminals: "Terminals", win98: "Herdr 98" }[l] ?? label;
    list.push({ name: "layout.switch", args: { name: l }, group: tr("palette.group.layout"), title: tr("palette.layout_named", { name: label }), words: `look layout ${l} layout: ${english} 布局 外观${l === "terminals" ? " 终端" : ""}` });
  }
  // Anything new in the app shows up too, until it gets a better name here.
  const namedIds = new Set(NAMED.map(([n]) => n));
  for (const c of commands()) {
    if (namedIds.has(c.name) || HIDDEN.has(c.name) || c.args.some((a) => a.required && a.name !== "name")) continue;
    list.push({ name: c.name, args: {}, ...titleOf(c.name), words: c.about });
  }
  return list.map((e) => ({ ...e, id: `${e.name}:${JSON.stringify(e.args)}` }));
}

// The key bound to an entry: `name` or `name:value` in keys.json.
function keyOf(e, bound) {
  const v = Object.values(e.args)[0];
  const want = v === undefined ? e.name : `${e.name}:${v}`;
  const k = bound.find((b) => b.section === "global" && b.action === want);
  return k ? k.keys : null;
}

// "ctrl-shift-p" -> ["ctrl", "shift", "p"]; "ctrl--" -> ["ctrl", "-"].
function keyParts(k) {
  return k.endsWith("--") ? [...k.slice(0, -2).split("-"), "-"] : k.split("-");
}

// Fuzzy score of `q` in `text`, with the matched positions; null: no match.
function fuzzy(q, text) {
  const t = text.toLowerCase();
  let score = 0;
  let at = 0;
  let run = 0;
  const hits = [];
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return null;
    const start = i === 0 || /[\s:.\-_/]/.test(t[i - 1]);
    run = i === at && hits.length ? run + 1 : 0;
    score += 1 + (start ? 6 : 0) + run * 3 - Math.min(i - at, 6) * 0.3;
    hits.push(i);
    at = i + 1;
  }
  return { score: score - text.length * 0.02, hits };
}

export default class Palette extends View {
  init(_props, cx) {
    this.query = "";
    this.input = InputState.new({ placeholder: tr("palette.placeholder") });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.go(this.rows()[this.at]?.e));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.at = 0;
    // How far the list is scrolled, px.
    this.scroll = 0;
    this.recent = JSON.parse(localStorage.getItem("recent") ?? "[]");
    this.handle = cx.focus_handle();
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(e) {
    if (!e) return;
    this.recent = [e.id, ...this.recent.filter((r) => r !== e.id)].slice(0, 20);
    localStorage.setItem("recent", JSON.stringify(this.recent));
    this.close();
    if (e.name === "mod.clone") {
      openOverlay({ mod: "prompt", kind: "dialog", width: 380, props: {
        title: tr("palette.cmd.duplicate_mod"), hint: tr("palette.duplicate_mod_hint"),
        command: { name: "mod.clone", args: {} },
      } });
    } else {
      run(e.name, e.name === "layout.clone" ? { name: shared("layout") ?? "main" } : e.args);
    }
  }

  // The rows to show: grouped when empty, ranked while typing.
  rows() {
    const all = entries();
    const GROUPS = groups();
    const q = this.query.trim().toLowerCase().replace(/\s+/g, "");
    if (!q) {
      const recent = this.recent.map((id) => all.find((e) => e.id === id)).filter(Boolean).slice(0, 5);
      const rest = GROUPS.slice(1).flatMap((g) => all.filter((e) => e.group === g && !recent.includes(e)));
      const others = all.filter((e) => !GROUPS.includes(e.group) && !recent.includes(e));
      return [...recent.map((e) => ({ e, head: GROUPS[0] })), ...[...rest, ...others].map((e) => ({ e, head: e.group }))];
    }
    const rank = (e) => this.recent.indexOf(e.id);
    return all
      .map((e) => {
        const title = fuzzy(q, e.title);
        const more = fuzzy(q, `${e.group} ${e.title} ${e.name} ${e.words}`);
        const best = title ?? (more && { score: more.score - 4, hits: [] });
        return best && { e, score: best.score, hits: best.hits };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || (rank(a.e) < 0 ? 99 : rank(a.e)) - (rank(b.e) < 0 ? 99 : rank(b.e)));
  }

  title(t, text, hits, on) {
    if (!hits?.length) return div().text_color(on ? t.foreground : t.muted).child(text);
    const parts = [];
    let cur = "";
    let lit = false;
    [...text].forEach((ch, i) => {
      const h = hits.includes(i);
      if (h !== lit && cur) {
        parts.push([cur, lit]);
        cur = "";
      }
      lit = h;
      cur += ch;
    });
    if (cur) parts.push([cur, lit]);
    return h_flex().children(parts.map(([s, h]) => div().text_color(h ? t.accent : on ? t.foreground : t.muted).when(h, (d) => d.font_semibold()).child(s.replace(/ /g, "\u00a0"))));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const bound = keys();
    this.at = Math.min(this.at, Math.max(0, rows.length - 1));
    // One continuous strip: each row (and the group title before it) at a
    // fixed y. Scrolling moves the strip in pixels, only as far as it takes to
    // keep the selected row (and its group's title, if it opens one) in view.
    const tops = [];
    let y = 0;
    rows.forEach((r, i) => {
      const head = !this.query && (i === 0 || r.head !== rows[i - 1].head);
      tops.push({ head, title: y, row: y + (head ? HEAD_H : 0) });
      y += (head ? HEAD_H : 0) + ROW_H;
    });
    const total = y;
    const fixed = total > LIST_H;
    this.maxScroll = Math.max(0, total - LIST_H);
    const sel = tops[this.at];
    if (sel) {
      const from = sel.head ? sel.title : sel.row;
      if (from < this.scroll) this.scroll = from;
      if (sel.row + ROW_H > this.scroll + LIST_H) this.scroll = sel.row + ROW_H - LIST_H;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));
    const key = (k) =>
      h_flex().gap(3).children(keyParts(k).map((p) => div().px(5).rounded(4).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(t.dim).child(p)));
    // In a scrolling list each item is placed at its edges from the model
    // above, not stacked: GPUI rounds every height to whole pixels, and a
    // stack of rounded heights drifts away from the model (19 px at zoom 1.3
    // by row 40, cutting the selection off). Edges from the model can't add up.
    const place = (el, start, end) =>
      fixed
        ? el.absolute().left(0).right(0).top(start - this.scroll).bottom(LIST_H - (end - this.scroll))
        : el.flex_none().h(end - start);
    const visible = (start, end) => !fixed || (end > this.scroll && start < this.scroll + LIST_H);
    const list = [];
    rows.forEach((r, i) => {
      const { head, title, row } = tops[i];
      if (head && visible(title, row)) list.push(place(h_flex(), title, row).px(14).pb(4).items_end().text_size(11).font_semibold().text_color(t.dim).child(r.head));
      if (!visible(row, row + ROW_H)) return;
      const on = i === this.at;
      const k = keyOf(r.e, bound);
      list.push(
        place(h_flex(), row, row + ROW_H)
          .id(`pl-${i}`)
          .mx(6)
          .px(10)
          .gap(10)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .text_size(12.8)
          .when(on, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r.e))
          .child(div().flex_1().min_w(0).child(this.title(t, r.e.title, r.hits, on)))
          .when(Boolean(this.query), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(r.e.group)))
          .when(Boolean(k), (el) => el.child(key(k))),
      );
    });
    return v_flex()
      .id("palette")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        // Stops at the ends: wrapping jumps out of sight.
        if (k === "down") this.at = Math.min(this.at + 1, rows.length - 1);
        else if (k === "up") this.at = Math.max(this.at - 1, 0);
        else if (k === "pagedown") this.at = Math.min(this.at + SHOWN, rows.length - 1);
        else if (k === "pageup") this.at = Math.max(this.at - SHOWN, 0);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(10)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(svg(win()?.platform === "macos" ? "frame/palette/command.svg" : "mods/workspace-chrome/search.svg").size(16).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(
        rows.length
          ? div()
              .id("palette-rows")
              .relative()
              .mb(6)
              .when(fixed, (el) => el.h(LIST_H).overflow_hidden())
              .on_scroll_wheel((e, cx) => {
                // The event bridge converts both wheel and touchpad deltas to pixels.
                this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, this.maxScroll));
                // The selection stays on screen, so the next frame doesn't scroll back to it.
                // A row that opens a group is shown with its title, so the title counts.
                while (this.at < rows.length - 1 && (tops[this.at].head ? tops[this.at].title : tops[this.at].row) < this.scroll) this.at++;
                while (this.at > 0 && tops[this.at].row + ROW_H > this.scroll + LIST_H) this.at--;
                cx.notify();
              })
              .children(fixed ? list : [v_flex().children(list)])
          : div().px(16).py(14).text_size(13).text_color(t.dim).child(`${tr("palette.nothing_matches")}${tr("palette.nothing_query", { query: this.query })}`),
      );
  }
}
