/*
 * B站评论 IP 属地 —— 页面上下文钩子 (page hook)
 *
 * 这个文件由 content.js 以 <script src="chrome-extension://..."> 的形式插入到网页自己的
 * JS 上下文里运行（扩展的 content script 运行在隔离环境，拿不到页面发出的请求）。
 *
 * 职责只有一件：监听页面自己对 B 站评论接口的请求，把响应里的
 * `reply_control.location`（形如 "IP属地：上海"）连同 mid / rpid 提取出来，
 * 通过自定义事件交给 content.js。
 *
 * 重要：这个字段只有在「携带登录 Cookie」的请求里才会返回内容，匿名请求返回空字符串。
 * 所以必须抓页面自己的请求，而不是扩展再去发一次请求。
 */
(function () {
  'use strict';

  if (window.__BILI_IP_LOCATION_HOOK__) return;
  window.__BILI_IP_LOCATION_HOOK__ = true;

  var DATA_EVENT = 'bili-ip-location:data';
  var READY_EVENT = 'bili-ip-location:ready';

  /** 命中 B 站评论相关接口 */
  function isReplyApi(url) {
    if (!url) return false;
    var s = String(url);
    return s.indexOf('api.bilibili.com') !== -1 && s.indexOf('/x/v2/reply') !== -1;
  }

  /** 把一条 reply 对象里的属地信息抽出来 */
  function pick(reply, out) {
    if (!reply || typeof reply !== 'object') return;
    var ctrl = reply.reply_control;
    var loc = ctrl && ctrl.location;
    if (!loc || typeof loc !== 'string') return;

    var mid = (reply.member && (reply.member.mid || reply.member.mid_str)) ||
      reply.mid || reply.mid_str;
    if (!mid) return;

    out.push({
      mid: String(mid),
      rpid: String(reply.rpid_str || reply.rpid || ''),
      loc: loc
    });
  }

  /** 遍历评论接口响应，收集所有能拿到属地的评论 */
  function collect(json) {
    if (!json || typeof json !== 'object') return;
    var data = json.data;
    if (!data || typeof data !== 'object') return;

    var out = [];
    var lists = [data.replies, data.top_replies, data.hots, data.root];

    for (var i = 0; i < lists.length; i++) {
      var list = lists[i];
      if (Array.isArray(list)) {
        for (var j = 0; j < list.length; j++) {
          var item = list[j];
          pick(item, out);
          var sub = item && item.replies;
          if (Array.isArray(sub)) {
            for (var k = 0; k < sub.length; k++) pick(sub[k], out);
          }
        }
      } else if (list && typeof list === 'object') {
        pick(list, out);
        if (Array.isArray(list.replies)) {
          for (var m = 0; m < list.replies.length; m++) pick(list.replies[m], out);
        }
      }
    }

    if (!out.length) return;
    try {
      window.dispatchEvent(new CustomEvent(DATA_EVENT, { detail: JSON.stringify(out) }));
    } catch (e) { /* 忽略 */ }
  }

  function feed(text) {
    if (!text) return;
    try {
      collect(JSON.parse(text));
    } catch (e) { /* 不是 JSON，忽略 */ }
  }

  /* ---------- 拦截 fetch ---------- */
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function () {
      var args = arguments;
      var url = '';
      try {
        var a0 = args[0];
        url = a0 && a0.url ? a0.url : String(a0);
      } catch (e) { /* 忽略 */ }

      var promise = nativeFetch.apply(this, args);

      if (!isReplyApi(url)) return promise;

      return promise.then(function (response) {
        try {
          // 用 clone 读取，绝不消耗页面自己要用的那个 body
          response.clone().text().then(feed, function () {});
        } catch (e) { /* 忽略 */ }
        return response;
      });
    };
  }

  /* ---------- 拦截 XMLHttpRequest ---------- */
  var nativeOpen = XMLHttpRequest.prototype.open;
  var nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__biliIpUrl = String(url); } catch (e) { /* 忽略 */ }
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    try {
      if (isReplyApi(this.__biliIpUrl)) {
        this.addEventListener('load', function () {
          try {
            var rt = this.responseType;
            if (rt === '' || rt === 'text') feed(this.responseText);
            else if (rt === 'json') collect(this.response);
          } catch (e) { /* 忽略 */ }
        });
      }
    } catch (e) { /* 忽略 */ }
    return nativeSend.apply(this, arguments);
  };

  /* 通知 content.js：钩子已就位 */
  try {
    window.dispatchEvent(new CustomEvent(READY_EVENT));
  } catch (e) { /* 忽略 */ }
})();
