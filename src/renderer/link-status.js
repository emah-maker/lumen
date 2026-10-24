const bubble = document.getElementById('bubble');
window.linkStatus.onText((text) => { if (bubble.textContent !== text) bubble.textContent = text; });
document.addEventListener('mouseenter', () => window.linkStatus.dodge()); // (the bubble cannot let clicks through: it moves aside instead)
document.addEventListener('mousemove', () => window.linkStatus.dodge(), { once: true });
