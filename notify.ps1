param(
  [string]$Title,
  [string]$Body
)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
  [Windows.UI.Notifications.ToastTemplateType]::ToastText02
)
$nodes = $t.GetElementsByTagName("text")
$nodes.Item(0).AppendChild($t.CreateTextNode($Title)) | Out-Null
$nodes.Item(1).AppendChild($t.CreateTextNode($Body))  | Out-Null
$n = New-Object Windows.UI.Notifications.ToastNotification $t
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("JiraQA").Show($n)
