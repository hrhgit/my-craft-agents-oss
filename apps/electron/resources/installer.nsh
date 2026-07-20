!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
  Var DeveloperKitCheckbox
  Var InstallDeveloperKit
!endif

!macro customInit
  # New offline installs include the Developer Kit by default. During an
  # update, preserve the user's existing component choice without showing UI.
  StrCpy $InstallDeveloperKit "1"
  IfFileExists "$INSTDIR\resources\app\package.json" 0 done
  IfFileExists "$INSTDIR\resources\developer-kit\developer-kit.json" 0 noDeveloperKit
  Goto done
noDeveloperKit:
  StrCpy $InstallDeveloperKit "0"
done:
!macroend

!macro customPageAfterChangeDir
  Page custom DeveloperKitPageCreate DeveloperKitPageLeave
!macroend

!ifndef BUILD_UNINSTALLER
Function DeveloperKitPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 26u "Install the Mortise Developer Kit for extension authoring and AI-operated UI validation. It is optional and can be configured later in Settings > Developer."
  Pop $0
  ${NSD_CreateCheckbox} 0 36u 100% 12u "Install Mortise Developer Kit (recommended for developers)"
  Pop $DeveloperKitCheckbox
  ${If} $InstallDeveloperKit == "1"
    ${NSD_SetState} $DeveloperKitCheckbox ${BST_CHECKED}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function DeveloperKitPageLeave
  ${NSD_GetState} $DeveloperKitCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $InstallDeveloperKit "1"
  ${Else}
    StrCpy $InstallDeveloperKit "0"
  ${EndIf}
FunctionEnd

!endif

!macro customInstall
  ${If} $InstallDeveloperKit == "0"
    RMDir /r "$INSTDIR\resources\developer-kit"
  ${EndIf}
!macroend
