import { createApp } from "vue";
import App from "./App.vue";
import RemoteMic from "./views/RemoteMic.vue";
import VoiceKiosk from "./views/VoiceKiosk.vue";
import { connect } from "./store";
import "./style.css";

// A phone opened the voice chat's mic link (#mic?s=…): only the mic page, which pairs the phone itself if needed.
if (location.hash.startsWith("#mic")) createApp(RemoteMic).mount("#app");
else {
  // Signed in (or a server without auth): open the live stream; otherwise App shows the sign-in screen.
  const setup = new URLSearchParams(location.search).get("setup");
  fetch(`/api/v1/auth/me${setup ? `?setup=${encodeURIComponent(setup)}` : ""}`).then((r) => r.json()).catch(() => ({ signedIn: true, owner: true }))
    .then((me: { signedIn: boolean; auth: string; owner: boolean; canClaim: boolean; ownerName: string | null }) => {
      // The TV screens (#voice-chat?kiosk=1, #house?kiosk=1): only that view. Not signed in yet: the normal sign-in, then back here.
      const KIOSK = /^#(voice-chat|house)\?(.*&)?kiosk=1\b/;
      // signing in on the TV goes through the normal panel (which rewrites the address): come back to the kiosk after
      try {
        if (!me.signedIn && KIOSK.test(location.hash)) sessionStorage.setItem("sd.kiosk", location.hash);
        const back = sessionStorage.getItem("sd.kiosk");
        if (me.signedIn && back) { sessionStorage.removeItem("sd.kiosk"); if (!KIOSK.test(location.hash)) history.replaceState(null, "", back); }
      } catch { /* no storage */ }
      if (me.signedIn && KIOSK.test(location.hash)) {
        // the house needs the live stream (lamp states); three.js loads in its own chunk
        if (location.hash.startsWith("#house")) { connect(); void import("./views/HouseKiosk.vue").then((m) => createApp(m.default).mount("#app")); }
        else createApp(VoiceKiosk).mount("#app");
        return;
      }
      if (me.signedIn) connect();
      createApp(App, { signedIn: me.signedIn, authOn: me.auth === "token", owner: me.owner, canClaim: me.canClaim, ownerName: me.ownerName }).mount("#app");
    });
}
