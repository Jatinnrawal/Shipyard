if (location.protocol === 'file:') {
  document.querySelector('.app-shell').hidden = true;
  document.getElementById('auth-gate').hidden = true;
  document.getElementById('file-open-notice').hidden = false;
}
