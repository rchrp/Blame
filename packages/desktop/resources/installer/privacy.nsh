; Privacy page of the Windows installer, shown after the folder choice.
; SignPath Foundation, which signs Blame's Windows releases, requires software
; that sends data to systems the user did not choose to show its privacy policy
; during installation and to offer install options that turn it off.
; The choices go to installer-privacy-choices.json in the app's data folder;
; the app applies them at its next launch and only to turn something off
; (packages/desktop/src/main/privacy-preferences.ts).

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var blamePrivacyTelemetryBox
  Var blamePrivacyUpdatesBox
  Var blamePrivacyTelemetry
  Var blamePrivacyUpdates

  !macro customPageAfterChangeDir
    Page custom blamePrivacyPageShow blamePrivacyPageLeave

    Function blamePrivacyPageShow
      ; Updates run silently and keep the choices made at the first install.
      ${if} ${isUpdated}
        Abort
      ${endif}
      !insertmacro MUI_HEADER_TEXT "Privacy" "Choose what Blame may send on its own."
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateLabel} 0 0 100% 52u "Each time it starts, Blame asks download.blame.so whether a newer version exists. While you are signed in, it also sends minimised usage, performance and error data to api.blame.so. Neither includes your code, prompts, file paths or messages."
      Pop $0
      ${NSD_CreateLink} 0 54u 100% 12u "Read the privacy policy: https://blame.so/privacy"
      Pop $0
      ${NSD_OnClick} $0 blamePrivacyOpenPolicy
      ${NSD_CreateCheckbox} 0 76u 100% 12u "Send usage and error telemetry"
      Pop $blamePrivacyTelemetryBox
      ${if} $blamePrivacyTelemetry != ${BST_UNCHECKED}
        ${NSD_Check} $blamePrivacyTelemetryBox
      ${endif}
      ${NSD_CreateCheckbox} 0 92u 100% 12u "Check for updates when Blame starts"
      Pop $blamePrivacyUpdatesBox
      ${if} $blamePrivacyUpdates != ${BST_UNCHECKED}
        ${NSD_Check} $blamePrivacyUpdatesBox
      ${endif}
      ${NSD_CreateLabel} 0 112u 100% 24u "You can change both later in Settings > Desktop > Privacy."
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function blamePrivacyPageLeave
      ${NSD_GetState} $blamePrivacyTelemetryBox $blamePrivacyTelemetry
      ${NSD_GetState} $blamePrivacyUpdatesBox $blamePrivacyUpdates
    FunctionEnd

    Function blamePrivacyOpenPolicy
      ExecShell "open" "https://blame.so/privacy"
    FunctionEnd
  !macroend

  !macro blamePrivacyFlag variable
    ${if} ${variable} == ${BST_UNCHECKED}
      FileWrite $0 "false"
    ${else}
      FileWrite $0 "true"
    ${endif}
  !macroend

  !macro customInstall
    ; Only an install where the page was shown has choices to write.
    ${ifNot} ${Silent}
    ${andIfNot} ${isUpdated}
      ; The app keeps its data in %APPDATA%\<appId> of the user who installs it.
      SetShellVarContext current
      CreateDirectory "$APPDATA\${APP_ID}"
      FileOpen $0 "$APPDATA\${APP_ID}\installer-privacy-choices.json" w
      FileWrite $0 '{"telemetry":'
      !insertmacro blamePrivacyFlag $blamePrivacyTelemetry
      FileWrite $0 ',"updateChecks":'
      !insertmacro blamePrivacyFlag $blamePrivacyUpdates
      FileWrite $0 '}'
      FileClose $0
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    ${endIf}
  !macroend
!endif
