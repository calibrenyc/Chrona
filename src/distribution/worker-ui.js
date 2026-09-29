window.updater.onStatus(value => {
  document.body.dataset.theme = value.darkMode ? 'dark' : 'light';
  document.querySelector('#stage').textContent = value.stage;
  document.querySelector('#progress').value = value.percent || 0;
  document.querySelector('#actions').hidden = !value.error;
  document.querySelector('#launch').hidden = !value.safe;
  document.querySelector('#message').textContent = value.message || 'Your library and preferences stay with you.';
});
document.addEventListener('click', event => {
  if (event.target.dataset.action) window.updater.action(event.target.dataset.action).catch(() => {});
});
