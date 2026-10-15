// A tiny WPF window for test/desktop-apps.js: a textbox, a button, a label, a checkbox and a password box. Built by the test with csc and run
// by PID; it is never activated (ShowActivated = false, no taskbar button) and sits off the user's screen area. WPF, because its controls
// report real UI Automation types and patterns (Edit, Button, CheckBox) and a PasswordBox reports IsPassword.
using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

class TestApp {
  [STAThread] static void Main(string[] args) {
    string title = args.Length > 0 ? args[0] : "Lumen UIA Test";
    string[] xy = (args.Length > 1 ? args[1] : "-3000,100").Split(',');
    Application app = new Application();
    Window w = new Window { Title = title, Width = 380, Height = 340, ShowActivated = false, ShowInTaskbar = false, WindowStartupLocation = WindowStartupLocation.Manual, Left = double.Parse(xy[0]), Top = double.Parse(xy[1]), WindowStyle = WindowStyle.ToolWindow };
    StackPanel panel = new StackPanel { Margin = new Thickness(12) };
    TextBox name = new TextBox { Width = 220, HorizontalAlignment = HorizontalAlignment.Left };
    AutomationProperties.SetName(name, "Your name"); AutomationProperties.SetAutomationId(name, "txtName");
    Button go = new Button { Content = "Greet", Width = 100, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 8, 0, 0) };
    AutomationProperties.SetAutomationId(go, "btnGreet");
    TextBlock result = new TextBlock { Text = "Waiting", Margin = new Thickness(0, 8, 0, 0) };
    AutomationProperties.SetAutomationId(result, "lblResult");
    CheckBox agree = new CheckBox { Content = "I agree", Margin = new Thickness(0, 8, 0, 0) };
    AutomationProperties.SetAutomationId(agree, "chkAgree");
    PasswordBox pass = new PasswordBox { Password = "s3cret-value", Width = 220, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 8, 0, 0) };
    AutomationProperties.SetName(pass, "Secret"); AutomationProperties.SetAutomationId(pass, "txtSecret");
    TextBox pin = new TextBox { Text = "4111-plain-looking", Width = 220, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 8, 0, 0) }; // not a password box (IsPassword is false), but it calls itself a PIN
    AutomationProperties.SetName(pin, "Card PIN"); AutomationProperties.SetAutomationId(pin, "txtPin");
    go.Click += delegate { result.Text = "Hello, " + name.Text; w.Title = title + " - greeted " + name.Text; }; // (the title bar paints even where the window's client area does not, so a capture changes too)
    panel.Children.Add(name); panel.Children.Add(go); panel.Children.Add(result); panel.Children.Add(agree); panel.Children.Add(pass); panel.Children.Add(pin);
    w.Content = panel;
    app.Run(w);
  }
}
