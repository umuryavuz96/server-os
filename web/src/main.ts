import { createApp } from "vue";
import App from "./App.vue";
import { connect } from "./store";
import "./style.css";

// Signed in (or a server without auth): open the live stream; otherwise App shows the sign-in screen.
const setup = new URLSearchParams(location.search).get("setup");
fetch(`/api/v1/auth/me${setup ? `?setup=${encodeURIComponent(setup)}` : ""}`).then((r) => r.json()).catch(() => ({ signedIn: true, owner: true }))
  .then((me: { signedIn: boolean; auth: string; owner: boolean; canClaim: boolean; ownerName: string | null }) => {
    if (me.signedIn) connect();
    createApp(App, { signedIn: me.signedIn, authOn: me.auth === "token", owner: me.owner, canClaim: me.canClaim, ownerName: me.ownerName }).mount("#app");
  });
