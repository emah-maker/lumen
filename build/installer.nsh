; Lumen's additions to electron-builder's NSIS installer (package.json build.nsis.include).
;
; Lumen.exe is Electron's untouched binary on an unsigned build (Smart App Control trusts it; one edited with rcedit is
; blocked, see scripts/build/build.js), so its own icon is Electron's atom. electron-builder makes the Desktop and Start menu
; shortcuts with the exe's icon, so a fresh install showed Electron's icon on both until Lumen's first run fixed them
; (features/instance.js fixShortcutIcons, ~10 s in). Here they are made again with the shipped icon.ico, right after the
; installer made them, keeping the app ID Windows groups the taskbar button and notifications by.

!macro lumenIconLink LINK
  ${if} ${FileExists} "${LINK}"
    CreateShortCut "${LINK}" "$appExe" "" "$INSTDIR\resources\app\src\assets\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "${LINK}" "${APP_ID}"
  ${endIf}
!macroend

!macro customInstall
  !insertmacro lumenIconLink "$newStartMenuLink"
  !insertmacro lumenIconLink "$newDesktopLink"
  ; Explorer redraws the icons it has cached for the new shortcuts (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
