'use strict';

const path = require('node:path');
const COMMAND_CHANNEL = 'chat-call:command';
// Generated PNG data, kept in this module to preserve the source file layout.
const EXTRA_ICON_DATA = {"share":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACjklEQVR4nOxWvWsTYRh/nveCRaPQS0QEvVxpY9NEcdFRpA4u7mbRRXAXFwepLtXFv0Fw0UEcdBLFDkqlkx0EbYLRxmuKlWiagLZam3tfn/vskabJm7ThWugPLvd8vPd7fnm/GYQMBiFjV0CkWXDma+UqIlwBwFMAog82BVwhjmkh4EFmIH5/XbYxkDN+PqTwJegJxKO0fvDyhgLyc5VxUjoWSD4XAEuwCRBHlDgu+D7CnZFE/FYg76BUKu39zaNVt8vprZxP6/3TsAXIGTUaSvMVmao1JPvZkqpp2h8r50/CX3zfGX+8ubjXrvjMbFXPGZV5eoqF+crRVm1tLuJ0PNHn1HLgC6Bu6vdsZPilFeGHYvkwKvwlmUfoGaibMGHFWn0T5AzW6ngZWoUUprwmMxUIp6xYOxHN0JEAp3hksqF4QERkslMR0gKsSaqg8oY6MOmGyoG0a4uk1ROFgvzeIS1g2YyO0poZth2EpyDwupcTiNdQ4DPXTa3uWTwryystYFhXX9AecZvK3fyuxbKI4p9PIkR9QVcvevl0IjYhyxuRbYhUkV7jnp83KkHxeA6xHszLYueehibiwpqH36BLSA9BIzKaOpUzqncZ8L8pPTYFXcIXQIdCzbMFF0PtPqQ5YdJrDCRhczJcV8sfggNs+a1zdltRvOEcIFsDm4s4HQ9XnFquF2zYyXEsEBT6PY0cOSjsHXAumrWTPo7X1IZ4IfEQ6pVMFrQRZalrH7sk2RE9/gS6wPa8FW+Ej6VyktXRvv3Qv894ccvOFX+M2raIFDODqiHLKT0E+dLiSVrL72XacmYeO64d+izTVnoIaJFx6AE6moSfjNqgyVcTrdqYXJk9MRSbg14I6AVCXwX/AQAA//8jjkwcAAAABklEQVQDAOiT/z9/vtRfAAAAAElFTkSuQmCC","share-active":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACnUlEQVR4nOxWTWgTQRR+M7sqolB7ExQtWs3Nix5V6iFprbfq7kUvgndRa6pitVAlsC0ePAte9GA2VC+tCebQUs3JHrz7gyIKetAqWmqSeb7J7ibTEJPZtGER+sEyb957+96382bmLYeIwSFirBMwGylPZZ1zjLGzAHiQpptgdVgGYAuIeD8zkLxXb2T1CjvnPECA09ABULKH6f7kmTrdiuTjlPy6opohh1+wClC8LTQMKglvEYlRZe7BSt/ZDF2lb+AtOY087vYPL8AawMpNUinFMxK7QZZk0ex27YtL0lbbA13Fw8QnqLfTKvnQ9ORuwxQvSCyWy3hkanDk4798ZSwr5zgkpkB+YCUXSEK1U4CCbavKDN40S25NO9speY7EHfT0GAbLS12zd9SYaq7Qx7CSyIRZEmOKOiZ1rUg0QigCXnI2X5dcIcHmw5LQJmAVaJMaOEcL2OurvihmXyYbrcTxmbvad4c2Afwp+oCx/f70MRX1QtUG7DwNT/xpbKuxdFQ3rjaBTOJSlm7HGwh47evG3zYw8SewMRAl0lmB3U0k87pxTV1H+npMA4wHUzs7wZFhRUbKPHtsrARV+4hu1P+4GwrAz0qQT9Am2ibAfvQUaPFvUxFG0/HLBWgT1T3AOH4PWgOVdm+rF13bLkO1cSVbua+I6eXyUFuBxQ3PodK7vYheA1kb+LEClst+Lo+M6himHdMPhkEn4xBdAoLGl4w0Df1027FCIrofkgCR/pLpgi4imy6iR1KmVmtnEkkX2kDkF1GoFbCyqV5Ec6eUORd91IRuSpnGMdqKc1IWgr2bOjH8XjemNoGTTycOcI6vtJyxvM8duPpax1W7BCanb+wAQpVgKJ/aw4vmrqYBzfJbN37lA3SCQCcQ+Sn4CwAA//+kgWQCAAAABklEQVQDAGCS7XjG3YRcAAAAAElFTkSuQmCC","camera":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADSklEQVR4nOxXTWgTURCe9zb9ObSVNEmRFE0sxG7SaqV4EeqpHj0UWkQQbUEE61HBKnhtqQeVXnrw1uKliKAoXtSC1IOHCiI22RJMm0hQmp9K/alNm4zzNpvfJukuRHLpB9mdfTNv5nuzs/NeONQYHGqMfQImMAhfMD4BgDdJlIpUSUQ26XG23gEDYEaMl4LRfg7sdSWbFOCZLof1DVSbgN+PDTv1cS+JHek4uFDoiZ2mK0fAL3UJS5fLxbb0+N1F4PPK2kETl8YQwE1BGvNMzWR9XBUR7rudlhv583yrsXukv67pP9FlPY/cX0QMMEmacx8yvy1LwPc1fgxSKFLcBuUR/l23dfSk3f6ngPjaWpO0KSkktleYC0gkPYctDzLP2a9gcRHrKPjjisERI8D5heLgAt1tbb8Y4iUS16ECGMK43x9ryT5nBO9qpJcx/kGNA/iIb+I1Wbb9hCpAUSLN2MgfUrTzqv8UnPIcsbwXcvYz5Ix3YEYG9lyWrWWDK+GNTkwmBqkUu7QJS0yqfyK3tyyXshcL8YbizyhDKgHGcq8pvw/kNyWEcsGD0Unc2R5Tk8dy1jQ2Trq7ssN6q9Q8jpjKOCUCvFTQPaGE4tMIbKycXuiU1fg0GIBuAt5QdIA+pVEt0gYHPpz4sd0kflS8IzS6oaoYjnpXogN6/epuxVS9lzMyBRnsdJjzO+KMNxgNM2CvVFvOhe1TPX51Z4Cc96nBAd55HNZd7ViMCV3aFvt0utWfAXJ+IO0cvkNZkmldxlYPjBRhSLv3VLDpKbKtHgHG2EtNdNGWfLtY7wtGxZiryHZP6D8PSMkptsOvopppnPAFY710f5E+FqTO0mUoZ2ua0utWNwG53bZMlT5CxTijDVFANiR25nxQGx92l+mIpWCoEVGlz1I77acsLBTrxJjQCRswAMNHMtlpnafbvBKIdKYYc4sxarM+d4dN96pLEkgCxrjW3Gk1nr0myumA+oMy6M7uMIix3LAGJRSxI/Kw9kgvln2kfbMq2zG1xmaKegK0V077kt3jtH0rIKCSCMZnqYguwn8Fm3U7WoczTwU1ICXMV+jgGaBMnaN2SodP1gBVAW7RThmg1c6ZEubJAjpQY+z/Nas5gX8AAAD//ziftpkAAAAGSURBVAMAusQtcswqsfMAAAAASUVORK5CYII=","camera-active":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADL0lEQVR4nOxXTUhUURQ+56nNFFrUIoJ2gomaGa1rUZY/URo4M0hSBlFkixaG8wgi3CgzDhW5CGpV0kafQWqpo2WELVq0Ckpd5CIQhJKwBp0m553OffPmOT8+fa8mZuMHd94595x7v3P/zr0jQZYhQZaxGUAu2IQnGOgkIC+LOSmmKAD5lGr5JtgA2nF2jfkrkfDlej6EdLy/Sn4FmQ6gdrjbkZ8T/sRiIReVy2SKyxGILennUNRZNnLy2i8r/aYF4H7RtQdzSSaSSgDJmWDayeWAJhHdUWrk60ntRv23AbFVVz9w+W4YCcPc1yyz9SpV3jemAbjHfeWgSmKKd4M55sKRpX1Dp9uXktq+bs+HyLZpFveu01YQtvZVe+/GdeMUXH7/II/JlQ3Iv3IPTankAsrR9hB3fx4SR74GCKCjabh7e1w3TsHit8Vy7rxYd3oSCdPVwXr5J9iAUt02wZ9dqfV1A/4CpxMeEmAjq1tX8pZL+fsuKQAVqTC+IhLh0GC915TcPeEvxgg2EEKZ0JHgI22hp8oxeWYtfzEQVzAwgECN2gCjaCyTsQRIkiGrEpEZuWss4IPfOM3kHayeFUWTuU6zmUAi7eTo/a/y2sqE7mDXfSSSzezCJnzABiwH4An6z/CnRVd/kATNTsB8UXhqL4g63dai+1qC5VTMG+hiXOZs2KCcaEvMiI89o4E5zoLjCb7PrPRrZwkOxyKht301bWnpWKtjW5JvRgNA3BH7wry5jzSf5JvRAFT6orNUmDtRRbJvJgNAGNalIj7TN1LNrqBf1BWl+G4I6+8Ble5BjnSF1xl513e6g4FDCPhcmPh9cIp/XYZvHvtahOUZUGrlGVK146aDXJxbHomSSM4prNksI/5TAAL9Nd4ent9KHvJkmlGrw8qYj3XYfpLpF86Ee4TvAwlKNG4VpsQMwV9g9TKS1AVOMDGFsHSjhjqhZVIV1P2oX3bMs5AWAAtTUV3mTXaLc3odi7au43VQwOVgXIlS7hQYXAlwjwV6eBedg/8IJuzhF1FzXE/aA6EVx6WCnOVZzuUeiD0+HZAZiAeq6Lc3FHX4UgLKLjb/mmU9gD8AAAD///IvvXQAAAAGSURBVAMAEAUjM+HJ6G0AAAAASUVORK5CYII="};

// Windows owns the thumbnail toolbar. The app publishes only call state; all
// commands go back to the existing web call handlers for one source of truth.
function createCallTaskbar({ mainWindow, nativeImage, getContents, platform = process.platform, log = () => {} }) {
  let state = null;
  let signature = '';
  let disposed = false;
  const icons = new Map();
  const icon = name => {
    if (!icons.has(name)) icons.set(name, EXTRA_ICON_DATA[name] ? nativeImage.createFromDataURL(EXTRA_ICON_DATA[name]) : nativeImage.createFromPath(path.join(__dirname, 'assets', 'call-controls', `${name}.png`)));
    return icons.get(name);
  };
  function update(nextState, force = false) {
    state = nextState;
    if (disposed || platform !== 'win32' || mainWindow.isDestroyed()) return;
    const active = !!(state?.active && state.roomId && state.sessionId);
    const controls = state?.controls || {};
    const key = JSON.stringify([active, state?.roomId, state?.sessionId, !!controls.muted, !!controls.deafened, !!controls.listenOnly,
      !!controls.sharing, !!controls.cameraSharing, !!controls.screenPending, !!controls.cameraPending, state?.enabled !== false]);
    if (!force && signature === key) return;
    const roomId = state?.roomId, sessionId = state?.sessionId;
    const send = action => () => {
      const wc = getContents();
      if (disposed || !state?.active || state.roomId !== roomId || state.sessionId !== sessionId || !wc || wc.isDestroyed()) return;
      if (action === 'mute' && state.controls?.listenOnly) return;
      if (action === 'share' && state.controls?.screenPending || action === 'camera' && state.controls?.cameraPending) return;
      if (action === 'share' && !state.controls?.sharing || action === 'camera' && !state.controls?.cameraSharing) {
        // Capture consent stays in the visible app; never start a hidden capture.
        if (mainWindow.isMinimized?.()) mainWindow.restore();
        mainWindow.show?.(); mainWindow.focus?.(); wc.focus?.();
      }
      wc.send(COMMAND_CHANNEL, { action, roomId, sessionId });
    };
    const buttons = active ? [
      { tooltip: controls.listenOnly ? 'Microphone unavailable' : controls.muted ? 'Unmute' : 'Mute', icon: icon(controls.muted || controls.listenOnly ? 'mute-active' : 'mute'), flags: controls.listenOnly ? ['disabled'] : [], click: send('mute') },
      { tooltip: controls.deafened ? 'Undeafen' : 'Deafen', icon: icon(controls.deafened ? 'deafen-active' : 'deafen'), click: send('deafen') },
      { tooltip: controls.sharing ? 'Stop Sharing' : 'Screen Share', icon: icon(controls.sharing ? 'share-active' : 'share'), flags: controls.screenPending ? ['disabled'] : [], click: send('share') },
      { tooltip: controls.cameraSharing ? 'Stop Camera' : 'Camera', icon: icon(controls.cameraSharing ? 'camera-active' : 'camera'), flags: controls.cameraPending ? ['disabled'] : [], click: send('camera') },
      { tooltip: state.enabled !== false ? 'Turn Off Call Overlay' : 'Turn On Call Overlay', icon: icon(state.enabled !== false ? 'overlay-active' : 'overlay'), click: send('overlay') },
      { tooltip: 'Leave Call', icon: icon('leave'), flags: ['dismissonclick'], click: send('leave') },
    ] : [];
    try {
      // A false return (for example while Explorer is restarting) must remain
      // retryable on the next state update or window focus/restore.
      if (mainWindow.setThumbarButtons(buttons)) signature = key;
    } catch (error) { log(`Call taskbar controls unavailable: ${error.message}`); }
  }
  const refresh = () => update(state, true);
  mainWindow.on('show', refresh);
  mainWindow.on('restore', refresh);
  mainWindow.on('focus', refresh);
  function destroy() {
    disposed = true;
    for (const event of ['show', 'restore', 'focus']) mainWindow.removeListener(event, refresh);
    state = null;
    icons.clear();
  }
  mainWindow.once('closed', destroy);
  return { update, destroy };
}

module.exports = { createCallTaskbar, COMMAND_CHANNEL };
