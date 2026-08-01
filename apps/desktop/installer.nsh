; Uninstall opt-ins (SPEC-016 R-16, D10): the app root — worlds, the ledger, the credential
; file — is the user's work and is NEVER deleted by default. Removing worlds and removing
; credentials are separate, explicit questions, each naming what it actually destroys, and
; both default to keeping everything.
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
    "Also delete your WORLDS and their history?$\r$\n$\r$\nThis destroys every world folder under $PROFILE\ArkeStudio\worlds — canon, sheets, takes, everything. It cannot be undone.$\r$\n$\r$\nChoose No to keep them (recommended)." \
    /SD IDNO IDYES uninstDeleteWorlds IDNO uninstKeepWorlds
  uninstDeleteWorlds:
    RMDir /r "$PROFILE\ArkeStudio\worlds"
    Delete "$PROFILE\ArkeStudio\ledger.jsonl"
  uninstKeepWorlds:

  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
    "Also delete your stored PROVIDER CREDENTIALS?$\r$\n$\r$\nThis removes the encrypted key file at $PROFILE\ArkeStudio\credentials.dat. Your provider accounts are unaffected.$\r$\n$\r$\nChoose No to keep it (recommended)." \
    /SD IDNO IDYES uninstDeleteCreds IDNO uninstKeepCreds
  uninstDeleteCreds:
    Delete "$PROFILE\ArkeStudio\credentials.dat"
  uninstKeepCreds:
!macroend
