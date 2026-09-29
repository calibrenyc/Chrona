!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!define MUI_BGCOLOR "EDF1F5"
!define MUI_TEXTCOLOR "15181D"
!define MUI_INSTFILESPAGE_COLORS "15181D EDF1F5"
!define MUI_WELCOMEPAGE_TITLE "Welcome to Chrona"
!define MUI_WELCOMEPAGE_TEXT "Your library, in one place.$\r$\n$\r$\nChoose where Chrona lives, connect your game libraries, and make it yours. Your settings are preserved when updating or repairing."
!define MUI_FINISHPAGE_TITLE "Chrona is ready"
!include MUI2.nsh

!ifndef BUILD_UNINSTALLER
Var ChronaSteam
Var ChronaFolders
Var ChronaDark
Var ChronaScan
Var ChronaDesktop
Var ChronaMenu
Var ChronaExisting
Var ChronaInstalledVersion
Var ChronaControl
Var ChronaSteamControl
Var ChronaFoldersControl
Var ChronaDarkControl
Var ChronaScanControl
Var ChronaDesktopControl
Var ChronaMenuControl
!else
Var ChronaRemoveData
Var ChronaRemoveControl
!endif

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  StrCpy $ChronaFolders ""
  StrCpy $ChronaDark 0
  StrCpy $ChronaScan 1
  StrCpy $ChronaDesktop 1
  StrCpy $ChronaMenu 1
  StrCpy $ChronaExisting 0
  ReadRegStr $ChronaInstalledVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $ChronaInstalledVersion == ""
    StrCpy $ChronaInstalledVersion "Portable / not registered"
  ${EndIf}
  ReadRegStr $ChronaSteam HKCU "Software\Valve\Steam" "SteamPath"
  IfFileExists "$APPDATA\chrona-game-launcher\library.json" 0 +2
    StrCpy $ChronaExisting 1
!macroend

!macro customPageAfterChangeDir
  Page custom ChronaLibraries ChronaLibrariesLeave
  Page custom ChronaPreferences ChronaPreferencesLeave
!macroend

!macro ChronaInstallerFunctions
Function ChronaBrowseSteam
  nsDialogs::SelectFolderDialog "Choose your Steam installation or library root" "$ChronaSteam"
  Pop $0
  ${If} $0 != error
    StrCpy $ChronaSteam $0
    ${NSD_SetText} $ChronaSteamControl $0
  ${EndIf}
FunctionEnd

Function ChronaAddFolder
  nsDialogs::SelectFolderDialog "Choose a game library folder" ""
  Pop $0
  ${If} $0 != error
    ${If} $ChronaFolders == ""
      StrCpy $ChronaFolders $0
    ${Else}
      StrCpy $ChronaFolders "$ChronaFolders|$0"
    ${EndIf}
    ${NSD_SetText} $ChronaFoldersControl $ChronaFolders
  ${EndIf}
FunctionEnd

Function ChronaDetectSteam
  ReadRegStr $ChronaSteam HKCU "Software\Valve\Steam" "SteamPath"
  ${NSD_SetText} $ChronaSteamControl $ChronaSteam
FunctionEnd

Function ChronaLibraries
  ${If} $ChronaExisting == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Your game libraries" "Steam libraries are read from Steam's configuration when Chrona starts."
  nsDialogs::Create 1018
  Pop $ChronaControl
  SetCtlColors $ChronaControl 15181D EDF1F5
  ${NSD_CreateLabel} 0 0 100% 14u "STEAM INSTALLATION / LIBRARY"
  Pop $0
  ${NSD_CreateText} 0 20u 72% 14u "$ChronaSteam"
  Pop $ChronaSteamControl
  ${NSD_CreateButton} 76% 20u 24% 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 ChronaBrowseSteam
  ${NSD_CreateButton} 76% 39u 24% 14u "Rescan Steam"
  Pop $0
  ${NSD_OnClick} $0 ChronaDetectSteam
  ${NSD_CreateLabel} 0 62u 100% 14u "ADDITIONAL GAME FOLDERS"
  Pop $0
  ${NSD_CreateText} 0 82u 72% 14u "$ChronaFolders"
  Pop $ChronaFoldersControl
  ${NSD_CreateButton} 76% 82u 24% 14u "+ Add Folder"
  Pop $0
  ${NSD_OnClick} $0 ChronaAddFolder
  ${NSD_CreateLabel} 0 106u 100% 36u "Separate folders with |. Remove a folder by deleting its path. Epic and configured Steam libraries are detected automatically. You can add or remove libraries later in Chrona."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function ChronaLibrariesLeave
  ${NSD_GetText} $ChronaSteamControl $ChronaSteam
  ${NSD_GetText} $ChronaFoldersControl $ChronaFolders
FunctionEnd

Function ChronaPreferences
  !insertmacro MUI_HEADER_TEXT "Make Chrona yours" "Choose your shortcuts and startup preferences."
  nsDialogs::Create 1018
  Pop $ChronaControl
  SetCtlColors $ChronaControl 15181D EDF1F5
  ${If} $ChronaExisting == 0
    ${NSD_CreateCheckbox} 0 8u 100% 14u "Use dark appearance"
    Pop $ChronaDarkControl
    ${NSD_SetState} $ChronaDarkControl $ChronaDark
    ${NSD_CreateCheckbox} 0 32u 100% 14u "Scan game libraries when Chrona starts"
    Pop $ChronaScanControl
    ${NSD_SetState} $ChronaScanControl $ChronaScan
  ${Else}
    ${NSD_CreateLabel} 0 8u 100% 48u "Existing Chrona settings detected. Installed version: $ChronaInstalledVersion. Installer version: ${VERSION}.$\r$\nYour libraries and preferences will be preserved. Continue to update or repair. Use Back to change the installation location."
    Pop $0
  ${EndIf}
  ${NSD_CreateCheckbox} 0 62u 100% 14u "Create a Desktop shortcut"
  Pop $ChronaDesktopControl
  ${NSD_SetState} $ChronaDesktopControl $ChronaDesktop
  ${NSD_CreateCheckbox} 0 86u 100% 14u "Create a Start Menu shortcut"
  Pop $ChronaMenuControl
  ${NSD_SetState} $ChronaMenuControl $ChronaMenu
  nsDialogs::Show
FunctionEnd

Function ChronaPreferencesLeave
  ${If} $ChronaExisting == 0
    ${NSD_GetState} $ChronaDarkControl $ChronaDark
    ${NSD_GetState} $ChronaScanControl $ChronaScan
  ${EndIf}
  ${NSD_GetState} $ChronaDesktopControl $ChronaDesktop
  ${NSD_GetState} $ChronaMenuControl $ChronaMenu
FunctionEnd
!macroend

!macro customInstall
  ${If} $ChronaExisting == 0
    CreateDirectory "$APPDATA\chrona-game-launcher"
    WriteINIStr "$APPDATA\chrona-game-launcher\installer-setup.ini" "setup" "complete" "1"
    WriteINIStr "$APPDATA\chrona-game-launcher\installer-setup.ini" "setup" "steam" "$ChronaSteam"
    WriteINIStr "$APPDATA\chrona-game-launcher\installer-setup.ini" "setup" "folders" "$ChronaFolders"
    WriteINIStr "$APPDATA\chrona-game-launcher\installer-setup.ini" "setup" "darkMode" "$ChronaDark"
    WriteINIStr "$APPDATA\chrona-game-launcher\installer-setup.ini" "setup" "scanOnStartup" "$ChronaScan"
  ${EndIf}
  ${If} $ChronaDesktop == 0
    Delete "$newDesktopLink"
  ${EndIf}
  ${If} $ChronaMenu == 0
    Delete "$newStartMenuLink"
    StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${Else}
    CreateShortCut "$SMPROGRAMS\Chrona Updater.lnk" "$INSTDIR\ChronaUpdater.exe"
  ${EndIf}
  CreateDirectory "$APPDATA\chrona-game-launcher\logs"
  FileOpen $0 "$APPDATA\chrona-game-launcher\logs\installer.log" a
  FileWrite $0 "Installed Chrona ${VERSION} to $INSTDIR; settings preserved.$\r$\n"
  FileClose $0
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.ChronaData un.ChronaDataLeave
!macroend

!macro ChronaUninstallerFunctions
Function un.ChronaData
  StrCpy $ChronaRemoveData 0
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 42u "Your library and settings will be kept for reinstallation unless you choose to remove them."
  Pop $0
  ${NSD_CreateCheckbox} 0 50u 100% 16u "Remove Chrona user data and settings"
  Pop $ChronaRemoveControl
  ${NSD_SetState} $ChronaRemoveControl 0
  nsDialogs::Show
FunctionEnd

Function un.ChronaDataLeave
  ${NSD_GetState} $ChronaRemoveControl $ChronaRemoveData
FunctionEnd
!macroend

!macro customHeader
  SetFont "Segoe UI" 9
  !ifdef BUILD_UNINSTALLER
    !insertmacro ChronaUninstallerFunctions
  !else
    !insertmacro ChronaInstallerFunctions
  !endif
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Chrona Updater.lnk"
  ${IfNot} ${isUpdated}
    ${If} $ChronaRemoveData == 1
      RMDir /r "$APPDATA\chrona-game-launcher"
    ${EndIf}
  ${EndIf}
!macroend
