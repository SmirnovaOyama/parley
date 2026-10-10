// The page that shows a code block running: HTML pages, SVG pictures, React components, Mermaid
// diagrams and plain JavaScript. The chat puts it in a frame and hands it the code by postMessage.
// It's served sandboxed (an origin of its own, so nothing in it can act as this site: no cookies,
// no calls to the API) and may load scripts only from a few public CDNs.
import type { MiddlewareHandler } from "hono";

const CDNS = "https://cdn.jsdelivr.net https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com";

export const previewHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header(
    "Content-Security-Policy",
    [
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock",
      "default-src 'none'",
      `script-src 'unsafe-inline' 'unsafe-eval' blob: ${CDNS} https://cdn.tailwindcss.com`,
      `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
      "font-src https: data:",
      "img-src https: data: blob:",
      "media-src https: data: blob:",
      `connect-src ${CDNS}`,
      "worker-src blob:",
      "frame-ancestors 'self'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join("; "),
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "public, max-age=300");
};

/**
 * Waits for the code, then writes the page it makes. A small script added to every page reports
 * its height to the chat (so the frame fits it: the content's height, not the frame's, or each
 * resize would feed the next) and shows errors on the page.
 */
export const PREVIEW_SHELL = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#888}p{padding:16px}</style></head>
<body><p>Waiting for the code…</p>
<script>
(function () {
  var MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
  var REACT = "19.1.0";
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  // Reports the page's height, and shows any error at the foot of the page.
  var helper = "<script>(function(){var last=0;function size(){var h=Math.ceil(document.documentElement.offsetHeight);if(h!==last){last=h;parent.postMessage({type:'preview-size',height:h},'*')}}" +
    "function oops(m){var d=document.getElementById('__preview_error')||document.createElement('pre');d.id='__preview_error';d.style.cssText='margin:12px;padding:10px 12px;border-radius:8px;background:#fdecea;color:#8a1c12;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap';d.textContent=String(m);(document.body||document.documentElement).appendChild(d);size()}" +
    "window.addEventListener('error',function(e){oops(e.message||'Something went wrong')});window.addEventListener('unhandledrejection',function(e){oops((e.reason&&e.reason.message)||e.reason||'Something went wrong')});window.__previewError=oops;" +
    "addEventListener('load',size);setInterval(size,400);if(window.ResizeObserver)new ResizeObserver(size).observe(document.documentElement)})();<\\/script>";
  function page(head, body, dark) {
    var scheme = dark ? "color-scheme:dark;background:#1f1e1d;color:#eee" : "color-scheme:light;background:#fff;color:#222";
    return "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>" + helper +
      "<style>html,body{margin:0}body{font:15px/1.5 system-ui,sans-serif;" + scheme + "}</style>" + head + "</head><body>" + body + "</body></html>";
  }
  function htmlPage(code) {
    // A whole document keeps its own head; a fragment goes in a body.
    if (/<html[\\s>]/i.test(code) || /<!doctype/i.test(code)) {
      return /<head(\\s[^>]*)?>/i.test(code) ? code.replace(/<head(\\s[^>]*)?>/i, function (m) { return m + helper; }) : helper + code;
    }
    return page("", code);
  }
  // Runs a React component, inside the written page. It's kept as a real function and written out
  // with toString(), so it needs no escaping. Babel and Tailwind are loaded by script, not written in
  // as tags: Chrome may refuse cross-site scripts that document.write adds on a slow connection.
  async function runReact(src, MAP, REACT) {
    var load = function (urls) {
      return urls.reduce(function (chain, url) {
        return chain.catch(function () {
          return new Promise(function (ok, fail) {
            var s = document.createElement("script");
            s.src = url;
            s.onload = ok;
            s.onerror = fail;
            document.head.appendChild(s);
          });
        });
      }, Promise.reject());
    };
    load(["https://cdn.tailwindcss.com"]).catch(function () {});
    try {
      await load(["https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.4/babel.min.js", "https://unpkg.com/@babel/standalone@7.26.4/babel.min.js"]);
    } catch (e) {
      throw new Error("Couldn't load what runs React components, from cdn.jsdelivr.net or unpkg.com. Check the connection and try again");
    }
    var out = window.Babel.transform(src, { filename: "App.tsx", presets: [["react", { runtime: "automatic" }], "typescript"] }).code;
    // Bare imports other than React come from esm.sh, built against the same React.
    var fixed = out.replace(/(from\\s*|import\\s*\\(\\s*|import\\s+)(['"])([^'"./][^'"]*)\\2/g, function (m, a, q, name) {
      return name in MAP ? m : a + q + "https://esm.sh/" + name + "?deps=react@" + REACT + ",react-dom@" + REACT + q;
    });
    var mod = await import(URL.createObjectURL(new Blob([fixed], { type: "text/javascript" })));
    var App = mod.default || Object.values(mod).find(function (v) { return typeof v === "function"; });
    if (!App) throw new Error("The code has no component to show. Export one as default");
    var client = await import("react-dom/client");
    var React = await import("react");
    client.createRoot(document.getElementById("root")).render(React.createElement(App));
  }
  function reactPage(code, dark) {
    var deps = "?deps=react@" + REACT + ",react-dom@" + REACT;
    var map = { imports: {
      "react": "https://esm.sh/react@" + REACT, "react/jsx-runtime": "https://esm.sh/react@" + REACT + "/jsx-runtime",
      "react-dom": "https://esm.sh/react-dom@" + REACT + deps, "react-dom/client": "https://esm.sh/react-dom@" + REACT + "/client" + deps
    } };
    // Every "<" goes in escaped, so nothing in the code can close the script it sits in.
    var json = function (v) { return JSON.stringify(v).split("<").join("\\\\" + "u003c"); };
    return page(
      "<script type='importmap'>" + json(map) + "<\\/script>",
      "<div id='root'></div><script type='module'>(" + runReact.toString() + ")(" + json(code) + "," + json(map.imports) + "," + json(REACT) + ")" +
      ".catch(function(e){window.__previewError(e.message||e)})<\\/script>",
      dark
    );
  }
  function mermaidPage(code, dark) {
    return page("", "<div class='mermaid' style='padding:16px;display:flex;justify-content:center'>" + esc(code) + "</div>" +
      "<script type='module'>import m from '" + MERMAID + "';m.initialize({startOnLoad:false,theme:" + (dark ? "'dark'" : "'default'") + "});" +
      "m.run().catch(e=>window.__previewError(e.message||e))<\\/script>", dark);
  }
  function scriptPage(code, dark) {
    // Its console shows on the page, so a script that only logs still shows something.
    return page("<style>#out{margin:0;padding:12px 16px;font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap}#out .e{color:#c0392b}</style>",
      "<pre id='out'></pre><script>(function(){var out=document.getElementById('out');function line(cls,args){var d=document.createElement('div');if(cls)d.className=cls;" +
      "d.textContent=[].map.call(args,function(a){try{return typeof a==='string'?a:JSON.stringify(a,null,2)}catch(e){return String(a)}}).join(' ');out.appendChild(d)}" +
      "['log','info','debug'].forEach(function(k){var o=console[k];console[k]=function(){line('',arguments);o.apply(console,arguments)}});" +
      "['warn','error'].forEach(function(k){var o=console[k];console[k]=function(){line('e',arguments);o.apply(console,arguments)}})})();<\\/script>" +
      "<script>" + code.replace(/<\\/script/gi, "<\\\\/script") + "\\n<\\/script>", dark);
  }
  // Any site can open this page, so it takes code only from this site's own pages. The page's own
  // origin is opaque, but location.origin is still its address's: the chat's.
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.type !== "preview-code" || e.origin !== location.origin || e.source !== parent && e.source !== opener) return;
    var code = String(d.code || "");
    var html;
    if (d.kind === "html") html = htmlPage(code);
    else if (d.kind === "svg") html = page("<style>body{display:flex;justify-content:center;padding:16px}svg{max-width:100%;height:auto}</style>", code, d.dark);
    else if (d.kind === "react") html = reactPage(code, d.dark);
    else if (d.kind === "mermaid") html = mermaidPage(code, d.dark);
    else html = scriptPage(code, d.dark);
    document.open();
    document.write(html);
    document.close();
  });
  (parent !== window ? parent : opener) && (parent !== window ? parent : opener).postMessage({ type: "preview-ready" }, "*");
})();
</script></body></html>`;
