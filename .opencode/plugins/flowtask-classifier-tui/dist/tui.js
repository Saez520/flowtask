// tui.tsx
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal, createEffect, onCleanup } from "solid-js";
function findClassification(sessionID, api) {
  try {
    const messages = api.state.session.messages(sessionID);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const parts = api.state.part(msg.id);
      for (const part of parts) {
        if (part.type === "text") {
          const match = part.text.match(/\[FLOWTASK_CLASSIFICATION:\s*([^\]]+)\]/);
          if (match) {
            return match[1];
          }
        }
      }
    }
  } catch {
  }
  return null;
}
var tui = async (api) => {
  const slotPlugin = {
    slots: {
      app_bottom: (ctx, _props) => {
        try {
          const theme = () => api.theme.current;
          const [label, setLabel] = createSignal("(idle)");
          const refresh = () => {
            const route = api.route.current;
            if (route.name !== "session") {
              setLabel("(idle)");
              return;
            }
            const sid = route.params.sessionID;
            setLabel(findClassification(sid, api) ?? "(idle)");
          };
          createEffect(() => {
            refresh();
            const unsubMsg = api.event.on("message.updated", (event) => {
              const evtSid = event.properties.sessionID;
              const route = api.route.current;
              if (route.name === "session" && route.params.sessionID === evtSid) {
                refresh();
              }
            });
            const unsubCreated = api.event.on("session.created", () => refresh());
            onCleanup(() => {
              unsubMsg();
              unsubCreated();
            });
          });
          return (() => {
            var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createTextNode(`Flowtask Classifier \xB7 `);
            _$insertNode(_el$, _el$2);
            _$setProp(_el$, "paddingTop", 1);
            _$setProp(_el$, "paddingBottom", 1);
            _$setProp(_el$, "paddingLeft", 2);
            _$setProp(_el$, "paddingRight", 1);
            _$setProp(_el$, "border", ["left"]);
            _$setProp(_el$, "flexShrink", 0);
            _$insertNode(_el$2, _el$3);
            _$insert(_el$2, label, null);
            _$effect((_p$) => {
              var _v$ = theme().border, _v$2 = theme().backgroundPanel, _v$3 = theme().textMuted;
              _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "borderColor", _v$, _p$.e));
              _v$2 !== _p$.t && (_p$.t = _$setProp(_el$, "backgroundColor", _v$2, _p$.t));
              _v$3 !== _p$.a && (_p$.a = _$setProp(_el$2, "fg", _v$3, _p$.a));
              return _p$;
            }, {
              e: void 0,
              t: void 0,
              a: void 0
            });
            return _el$;
          })();
        } catch {
          return (() => {
            var _el$4 = _$createElement("box"), _el$5 = _$createElement("text");
            _$insertNode(_el$4, _el$5);
            _$setProp(_el$4, "paddingTop", 1);
            _$setProp(_el$4, "paddingBottom", 1);
            _$setProp(_el$4, "paddingLeft", 2);
            _$setProp(_el$4, "paddingRight", 1);
            _$insertNode(_el$5, _$createTextNode(`Flowtask Classifier \xB7 (idle)`));
            _$setProp(_el$5, "fg", "#888888");
            return _el$4;
          })();
        }
      }
    }
  };
  api.slots.register({
    order: 90,
    ...slotPlugin
  });
};
var tui_default = {
  id: "flowtask-classifier",
  tui
};
export {
  tui_default as default
};
