---
'@javis-dog/jgr-sdk': patch
'@javis-dog/collector-claude-code': patch
---

`createFileSpool` (JD-M02) and `createState` (JD-C01) no longer leave an unhandled promise rejection when their directory cannot be created. The error still reaches every caller that uses the spool or state.
