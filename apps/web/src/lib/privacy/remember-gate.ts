// Release gate for "Remember on this device" (review L1).
//
// ADR-0018 §11: remembered keys ship only after the CSP browser run passes on every page,
// including the signed-in project page where keys are entered. That run needs the owner's session
// (TEST_PLAN §S5f owner run) and has not been done. Until its evidence is recorded, this stays
// false: the key store never stores or loads keys on the device (and deletes rows left from
// earlier builds), and the UI neither offers remembering nor mentions it. The remember code and
// its unit tests stay; the tests force the gate on through `createKeyStore({ rememberEnabled })`.

/** Flip to true only with the owner's ADR-0018 §11 CSP run on the signed-in project page. */
export const REMEMBER_ON_DEVICE_ENABLED = false;
