# Receive from phone (Wi-Fi)

Send photos, videos and files from your phone to Lumen over your Wi-Fi. You don't need an app, an account or Telegram, and the files go straight from the phone to your computer. Your phone and computer must be on the same network.

## Use it

1. In Lumen, choose **File → Receive from phone (Wi-Fi)…**, or **From your phone (Wi-Fi)** in the chat's **+** menu.
2. Point your phone's camera at the QR code and open the link.
3. On your phone, tap **Choose photos or files**. Pick as many as you like. You can add a note first.
4. Each file shows **Sent** on the phone. In Lumen it is saved to **Downloads/From phone**, the same folder [Phone (Telegram)](telegram.md#send-files-and-links-from-your-phone) uses.
5. Press **Done** in Lumen.
   - Opened from the chat's **+** menu: the files go into the message box, and your note goes into the prompt. Nothing is sent until you press Send.
   - Opened from the File menu: the tab strip shows a toast with **Attach to chat**.
   - Programs and scripts (`.pkg`, `.dmg`, `.command`, `.exe` …) only get **Show in Finder**.

Files can be up to 2 GB each. A file that is cut off (the phone locks, the Wi-Fi drops) leaves nothing behind; send it again.

## What runs, and for how long

Lumen listens only while the QR sheet is open:

- It listens on this computer's Wi-Fi or Ethernet address only, on a random port. VPN tunnels and virtual machine networks are never used.
- It stops when you press **Done** or close the sheet, after 10 minutes with nothing sent, or after an hour in all. Opening it again makes a new address; the old one stops working.
- The address carries a one-time key of 32 random bytes. Lumen keeps only its fingerprint. Requests without the key get nothing, and 30 wrong tries end the session.
- The first device that opens the page owns the session. Any other device is turned away, even with the right link.
- The page only accepts uploads from itself, so another website can't send files to it. It loads nothing from anywhere else.
- Files are written to a hidden temporary file and appear in the folder only once complete. On macOS they are marked as downloaded, so Gatekeeper checks them before they run. Lumen leaves at least 1 GB of free disk.

## Use it on Wi-Fi you trust

The link is plain `http://` on your local network. Anyone on the same network who can watch its traffic could see the files on their way. That is fine at home or on your office network. Avoid it on public Wi-Fi (cafés, hotels, airports), or use [Phone (Telegram)](telegram.md) there.

## When it doesn't connect

- **"This computer isn't on a Wi-Fi or local network"**: connect to Wi-Fi or Ethernet first.
- **The phone can't open the page**: check that both are on the same network. Guest networks and some office networks keep devices apart ("client isolation"); use another network or Telegram. A VPN on the phone can also send the request elsewhere; pause it.
- **macOS asks whether Lumen may accept incoming connections**: that's the macOS firewall. Allow it to receive files this way.
- **"Another device is using this code"**: another device opened the link first. Press **Done** and open it again for a new code.
