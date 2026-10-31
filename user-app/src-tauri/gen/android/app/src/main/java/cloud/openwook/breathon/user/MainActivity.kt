package cloud.openwook.breathon.user

import android.os.Bundle
import android.view.KeyEvent
import android.view.ViewGroup
import android.webkit.WebView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.os.Build
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 33) {
      onBackInvokedDispatcher.registerOnBackInvokedCallback(
        OnBackInvokedDispatcher.PRIORITY_OVERLAY, OnBackInvokedCallback { appBack() })
    }
  }
  private fun appBack() {
    appWebView?.evaluateJavascript("window.appBack()") { handled ->
      if (handled != "true") moveTaskToBack(true)
    }
  }
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.keyCode == KeyEvent.KEYCODE_BACK) {
      if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) appBack()
      return true
    }
    return super.dispatchKeyEvent(event)
  }
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val params = view.layoutParams
      if (params is ViewGroup.MarginLayoutParams) {
        params.setMargins(bars.left, bars.top, bars.right, bars.bottom)
        view.layoutParams = params
      }
      insets
    }
    webView.post { ViewCompat.requestApplyInsets(webView) }
  }
}
