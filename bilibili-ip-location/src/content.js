/*
 * B站评论 IP 属地 —— content script
 *
 * 运行在扩展的隔离环境里，负责两件事：
 *   1. 把 src/hook.js 注入到网页自己的 JS 上下文，拿到 { mid, rpid, loc } 数据；
 *   2. 穿透评论区各层 Shadow DOM，把属地徽章插到用户名旁边的正确位置。
 */
(function () {
  'use strict';

  var DATA_EVENT = 'bili-ip-location:data';
  var READY_EVENT = 'bili-ip-location:ready';
  var BADGE_CLASS = 'bili-ip-location-badge';
  var MAX_ENTRIES = 20000;

  /* mid -> 属地文案。评论接口里同一用户可能多次出现，保留最后一条即可。 */
  var byMid = Object.create(null);
  var entryCount = 0;

  var stopped = false;
  var observedRoots = new WeakSet();
  var scanTimer = null;

  /* ------------------------------------------------------------------ *
   * 注入页面钩子
   * ------------------------------------------------------------------ */

  var hookReady = false;
  var injectAttempts = 0;

  function collectHookEvents() {
    window.addEventListener(READY_EVENT, function () {
      hookReady = true;
    });
  }

  function injectHook() {
    if (hookReady || stopped) return;
    injectAttempts++;

    try {
      var url = chrome.runtime.getURL('src/hook.js');
      var script = document.createElement('script');
      script.src = url;
      script.setAttribute('data-bili-ip-location-hook', '1');
      script.addEventListener('load', function () {
        if (script.parentNode) script.parentNode.removeChild(script);
      });
      script.addEventListener('error', function () {
        if (script.parentNode) script.parentNode.removeChild(script);
      });
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      // 扩展被重新加载后 chrome.runtime 会失效，此时直接停手
      if (String(e && e.message).indexOf('Extension context invalidated') !== -1) stopped = true;
    }

    // 钩子脚本是异步加载的，若迟迟没有就位就再补一次
    if (injectAttempts < 5) setTimeout(injectHook, 800);
  }

  /* ------------------------------------------------------------------ *
   * 接收数据
   * ------------------------------------------------------------------ */

  window.addEventListener(DATA_EVENT, function (event) {
    var items;
    try {
      items = JSON.parse(event.detail);
    } catch (e) {
      return;
    }
    if (!items || !items.length) return;

    var changed = false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.mid || !it.loc) continue;

      if (byMid[it.mid] !== it.loc) {
        if (!(it.mid in byMid)) {
          entryCount++;
          if (entryCount > MAX_ENTRIES) {
            byMid = Object.create(null);
            entryCount = 0;
          }
        }
        byMid[it.mid] = it.loc;
        changed = true;
      }
    }
    if (changed) scheduleScan();
  });

  /* ------------------------------------------------------------------ *
   * 样式
   * ------------------------------------------------------------------ */

  var palette = null;
  var paletteAt = 0;

  function channelLuminance(rgbText) {
    var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?/.exec(rgbText || '');
    if (!m) return null;
    var alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (alpha < 0.2) return null; // 基本透明，不能用来判断底色
    return 0.299 * (+m[1]) + 0.587 * (+m[2]) + 0.114 * (+m[3]);
  }

  function detectDark() {
    try {
      var probe = document.body || document.documentElement;
      if (!probe) return false;
      var style = getComputedStyle(probe);
      var bg = channelLuminance(style.backgroundColor);
      if (bg !== null) return bg < 128;
      // 背景透明时用文字颜色反推
      var fg = channelLuminance(style.color);
      if (fg !== null) return fg > 140;
    } catch (e) { /* 忽略 */ }
    return false;
  }

  function getPalette() {
    var now = Date.now();
    if (palette && now - paletteAt < 3000) return palette;
    paletteAt = now;
    palette = detectDark()
      ? { color: '#aeb3ba' }
      : { color: '#9499a0' };
    return palette;
  }

  /* 纯文字，不加任何底片 / 边框 / 圆角 */
  function applyBadgeStyle(el) {
    var p = getPalette();
    el.style.cssText = [
      'display: inline-block',
      'margin: 0 0 0 6px',
      'padding: 0',
      'border: 0',
      'background: none',
      'box-shadow: none',
      'border-radius: 0',
      'font-size: 12px',
      'line-height: 1',
      'font-weight: 400',
      'font-style: normal',
      'vertical-align: baseline',
      'white-space: nowrap',
      'user-select: text',
      'flex: none',
      'color: ' + p.color
    ].join(';');
  }

  function normalize(text) {
    var s = String(text).trim();
    if (!s) return '';
    return /^IP属地/.test(s) ? s : 'IP属地：' + s;
  }

  function makeBadge(text) {
    var badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.textContent = text;
    badge.title = text;
    applyBadgeStyle(badge);
    return badge;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function midFromHref(href) {
    var m = /space\.bilibili\.com\/(\d+)/.exec(href || '');
    return m ? m[1] : null;
  }

  /**
   * 新版评论区：<bili-comment-user-info> 的 Shadow DOM 里依次是
   *   #user-name（用户名） → #user-level（等级） → #user-medal（粉丝勋章）
   * 属地插在等级徽章右边。
   */
  function decorateUserInfo(host) {
    var sr = host.shadowRoot;
    if (!sr) return;

    var nameEl = sr.querySelector('#user-name');
    if (!nameEl) return;

    var mid = nameEl.getAttribute('data-user-profile-id');
    if (!mid) {
      var a = nameEl.querySelector('a[href*="space.bilibili.com/"]');
      mid = a ? midFromHref(a.getAttribute('href')) : null;
    }
    if (!mid) return;

    // 优先挂在等级徽章右边；没有等级元素时退回用户名右边
    var anchor = sr.querySelector('#user-level') || nameEl;
    var parent = anchor.parentNode;
    if (!parent) return;

    var existing = sr.querySelector('.' + BADGE_CLASS);
    var loc = byMid[mid];

    if (!loc) {
      if (existing) existing.parentNode.removeChild(existing);
      return;
    }

    loc = normalize(loc);
    if (existing) {
      if (existing.textContent !== loc) {
        existing.textContent = loc;
        existing.title = loc;
      }
      // Lit 重渲染后位置可能被挪走，这里纠正回来
      if (existing.previousElementSibling !== anchor) {
        if (anchor.nextSibling) parent.insertBefore(existing, anchor.nextSibling);
        else parent.appendChild(existing);
      }
      return;
    }

    var badge = makeBadge(loc);
    if (anchor.nextSibling) parent.insertBefore(badge, anchor.nextSibling);
    else parent.appendChild(badge);
  }

  /** 旧版评论区（Vue 组件）兜底 */
  function decorateLegacy(item) {
    var anchors = item.querySelectorAll('a[href*="space.bilibili.com/"]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];

      // 只认用户名链接，避免给「回复 @某人」之类的提及链接也加徽章
      var near = a.closest('[class*="user-name"], [class*="sub-user-name"], [class*="user"], .name');
      if (!near) continue;

      var mid = midFromHref(a.getAttribute('href'));
      if (!mid) continue;

      // 尽量挂到等级徽章右边：往上层找 1~3 层，看有没有等级元素
      var anchor = a;
      var scope = a.parentNode;
      for (var d = 0; d < 3 && scope && scope !== item.parentNode; d++) {
        var levelEl = scope.querySelector('[class*="level"], .level');
        if (levelEl) { anchor = levelEl; break; }
        scope = scope.parentNode;
      }

      var holder = anchor.parentNode;
      if (!holder) continue;

      var existing = null;
      var kids = holder.children;
      for (var k = 0; k < kids.length; k++) {
        if (kids[k].classList && kids[k].classList.contains(BADGE_CLASS)) { existing = kids[k]; break; }
      }

      var loc = byMid[mid];
      if (!loc) {
        if (existing) existing.parentNode.removeChild(existing);
        continue;
      }

      loc = normalize(loc);
      if (existing) {
        if (existing.textContent !== loc) {
          existing.textContent = loc;
          existing.title = loc;
        }
        if (existing.previousElementSibling !== anchor) {
          if (anchor.nextSibling) holder.insertBefore(existing, anchor.nextSibling);
          else holder.appendChild(existing);
        }
        continue;
      }

      var badge = makeBadge(loc);
      if (anchor.nextSibling) holder.insertBefore(badge, anchor.nextSibling);
      else holder.appendChild(badge);
    }
  }

  /** 递归处理一棵 DOM 树，并穿透其中的 Shadow DOM */
  function processRoot(root, depth) {
    if (!root || depth > 20) return;

    var list, i;

    list = root.querySelectorAll('bili-comment-user-info');
    for (i = 0; i < list.length; i++) decorateUserInfo(list[i]);

    list = root.querySelectorAll('.reply-item, .sub-reply-item, .reply-item-wrap');
    for (i = 0; i < list.length; i++) decorateLegacy(list[i]);

    var all = root.querySelectorAll('*');
    for (i = 0; i < all.length; i++) {
      var sr = all[i].shadowRoot;
      if (!sr) continue;
      ensureObserved(sr);
      processRoot(sr, depth + 1);
    }
  }

  /* ------------------------------------------------------------------ *
   * 调度
   * ------------------------------------------------------------------ */

  function hasCommentArea() {
    return !!document.querySelector(
      'bili-comments, bili-comment-user-info, #commentapp, .reply-item, .reply-list, .comment-container, #comment'
    );
  }

  function scan() {
    if (stopped || !entryCount) return;
    if (document.hidden) return;
    if (!hasCommentArea()) return;
    palette = null; // 强制重新判断主题色
    try {
      processRoot(document, 0);
    } catch (e) { /* 页面结构变化时不要抛出去 */ }
  }

  function scheduleScan() {
    if (stopped || scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scan();
    }, 200);
  }

  /** Shadow DOM 内部的变化不会触发外层 observer，所以要逐棵挂上 */
  function ensureObserved(shadowRoot) {
    if (observedRoots.has(shadowRoot)) return;
    observedRoots.add(shadowRoot);
    try {
      new MutationObserver(scheduleScan).observe(shadowRoot, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (e) { /* 忽略 */ }
  }

  function start() {
    collectHookEvents();
    injectHook();

    try {
      new MutationObserver(scheduleScan).observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (e) { /* 忽略 */ }

    // 兜底：虚拟列表回收、路由切换等场景靠定时兜住
    setInterval(scheduleScan, 2000);
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
