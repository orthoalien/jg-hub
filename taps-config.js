/* iTap board config. No patient data lives here.
   clientId: the Google OAuth Web client ID Greenie creates once (public by design).
   sheetId:  the private "Tap Board" Google Sheet. The ID alone opens nothing:
             Google only serves it to a signed-in account it is shared with. */
window.TAPS_CONFIG = {
  clientId: "588257456941-dq1vv6a6uld3gj1kkgc1ndccjsdbpuj0.apps.googleusercontent.com",
  sheetId: "1UCy-M5NY2sB-RUllIVgRNg7nmHcWbRpX5MtBmzYSH4I",
  account: "jgreenberg21@gmail.com",
  pollSeconds: 30
};
