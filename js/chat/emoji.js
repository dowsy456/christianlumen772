/* chat/emoji: methods register before ordered initialization. */
(function (App) {
  "use strict";
// Local, named emoji data: no network, custom element or shadow-DOM dependency.
const EMOJI_GROUPS = [
  ['Faces', '😀 grinning happy|😃 smile|😄 laughing|😁 grin|😆 laugh|😅 sweat smile|😂 tears joy|🤣 rolling laughing|🙂 slightly smiling|🙃 upside down|😉 wink|😊 blush|😇 angel|🥰 love hearts|😍 heart eyes|🤩 star eyes|😘 kiss|😗 kissing|☺️ smiling|😚 kiss eyes closed|😙 kiss smile|🥲 happy tear|😋 yummy|😛 tongue|😜 wink tongue|🤪 crazy|😝 squint tongue|🤑 money|🤗 hug|🤭 giggle|🫢 surprise|🫣 peeking|🤫 quiet shush|🤔 thinking|🫡 salute|🤐 zipper mouth|🤨 raised eyebrow|😐 neutral|😑 expressionless|😶 silent|😏 smirk|😒 unamused|🙄 rolling eyes|😬 grimace|😮‍💨 exhale|🤥 lying|😌 relieved|😔 sad|😪 sleepy|🤤 drooling|😴 sleep|😷 mask|🤒 sick|🤕 hurt|🤢 nauseous|🤮 vomit|🤧 sneeze|🥵 hot|🥶 cold|🥴 woozy|😵 dizzy|🤯 exploding mind|🤠 cowboy|🥳 party|🥸 disguise|😎 cool sunglasses|🤓 nerd|🧐 monocle|😕 confused|🫤 unsure|😟 worried|🙁 frown|☹️ frowning|😮 surprised|😯 hushed|😲 astonished|😳 flushed|🥺 pleading|🥹 tears|😦 frown open|😧 anguished|😨 afraid|😰 anxious|😥 disappointed|😢 crying|😭 sobbing|😱 scream|😖 confounded|😣 persevere|😞 disappointed|😓 downcast|😩 weary|😫 tired|🥱 yawn|😤 triumph|😡 angry|😠 mad|🤬 swearing|😈 devil|👿 angry devil|💀 skull|☠️ skull crossbones|💩 poop|🤡 clown|👻 ghost|👽 alien|👾 monster|🤖 robot|😺 cat smile|😸 cat grin|😹 cat joy|😻 cat heart eyes|😼 cat smirk|😽 cat kiss|🙀 cat scream|😿 cat crying|😾 cat angry'],
  ['People', '👋 wave hello|🤚 raised hand|🖐️ hand fingers|✋ stop hand|🖖 vulcan|🫱 right hand|🫲 left hand|🫳 palm down|🫴 palm up|👌 okay|🤌 pinched fingers|🤏 pinch|✌️ peace victory|🤞 crossed fingers|🫰 finger heart|🤟 love you|🤘 rock horns|🤙 call me|👈 left point|👉 right point|👆 up point|👇 down point|☝️ point up|🫵 pointing you|👍 thumbs up yes|👎 thumbs down no|✊ fist|👊 punch|🤛 left fist|🤜 right fist|👏 clap|🙌 raised hands|🫶 heart hands|👐 open hands|🤲 palms together|🤝 handshake|🙏 please pray thanks|✍️ writing|💅 nails|🤳 selfie|💪 muscle strong|🦾 robot arm|🧠 brain|🫀 heart organ|👀 eyes|👁️ eye|👂 ear|👃 nose|👄 mouth|👶 baby|🧒 child|👦 boy|👧 girl|🧑 person|👨 man|👩 woman|🧓 older person|👴 old man|👵 old woman|🙍 frowning person|🙎 pouting person|🙅 no gesture|🙆 okay gesture|💁 tipping hand|🙋 raising hand|🧏 deaf person|🙇 bow|🤦 facepalm|🤷 shrug|👮 police|👷 construction|🕵️ detective|💂 guard|🥷 ninja|🧑‍⚕️ doctor|🧑‍🎓 student|🧑‍🏫 teacher|🧑‍💻 programmer|🧑‍🚀 astronaut|🧑‍🍳 chef|🦸 superhero|🧙 wizard|🧛 vampire|🧟 zombie|🧚 fairy|🧜 merperson|🧞 genie|🚶 walking|🏃 running|💃 dancing|🕺 dancer|🧘 yoga|🛌 bed sleeping'],
  ['Nature', '🐶 dog|🐱 cat|🐭 mouse|🐹 hamster|🐰 rabbit|🦊 fox|🐻 bear|🐼 panda|🐻‍❄️ polar bear|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🙈 see no evil|🙉 hear no evil|🙊 speak no evil|🐔 chicken|🐧 penguin|🐦 bird|🐤 chick|🦆 duck|🦅 eagle|🦉 owl|🦇 bat|🐺 wolf|🐗 boar|🐴 horse|🦄 unicorn|🐝 bee|🪱 worm|🐛 bug|🦋 butterfly|🐌 snail|🐞 ladybug|🐜 ant|🦟 mosquito|🦗 cricket|🕷️ spider|🦂 scorpion|🐢 turtle|🐍 snake|🦎 lizard|🦖 dinosaur|🦕 dinosaur|🐙 octopus|🦑 squid|🦐 shrimp|🦀 crab|🐡 blowfish|🐠 tropical fish|🐟 fish|🐬 dolphin|🐳 whale|🦈 shark|🐊 crocodile|🐘 elephant|🦒 giraffe|🦓 zebra|🦏 rhino|🦛 hippo|🐪 camel|🦙 llama|🐎 horse running|🐕 dog|🐈 cat|🐇 bunny|🦔 hedgehog|🐿️ squirrel|🦦 otter|🦥 sloth|🦝 raccoon|🦨 skunk|🦡 badger|🐾 paw prints|🌵 cactus|🎄 christmas tree|🌲 evergreen|🌳 tree|🌴 palm|🌱 seedling|🌿 herb|☘️ shamrock|🍀 clover|🍁 maple|🍂 leaves|🍃 leaf wind|🌸 blossom|🌼 flower|🌻 sunflower|🌹 rose|🥀 wilted rose|🌷 tulip|🪻 hyacinth|🌺 hibiscus|🌎 earth|🌙 moon|⭐ star|🌟 glowing star|✨ sparkles|☀️ sun|🌤️ sun cloud|⛅ cloudy|🌧️ rain|⛈️ thunderstorm|🌈 rainbow|❄️ snowflake|☃️ snowman|⚡ lightning|🔥 fire|💧 water drop|🌊 wave'],
  ['Food', '🍏 green apple|🍎 apple|🍐 pear|🍊 orange|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🫐 blueberries|🍈 melon|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥝 kiwi|🍅 tomato|🍆 eggplant|🥑 avocado|🥦 broccoli|🥬 greens|🥒 cucumber|🌶️ pepper|🌽 corn|🥕 carrot|🧄 garlic|🧅 onion|🥔 potato|🍠 sweet potato|🥐 croissant|🥯 bagel|🍞 bread|🥖 baguette|🥨 pretzel|🧀 cheese|🥚 egg|🍳 breakfast|🥞 pancakes|🧇 waffle|🥓 bacon|🥩 steak|🍗 chicken|🍖 meat|🌭 hot dog|🍔 burger|🍟 fries|🍕 pizza|🥪 sandwich|🌮 taco|🌯 burrito|🥙 pita|🧆 falafel|🍜 noodles|🍝 spaghetti pasta|🍲 stew|🍛 curry|🍣 sushi|🍱 bento|🥟 dumpling|🍤 shrimp|🍙 rice ball|🍚 rice|🍘 rice cracker|🍥 fish cake|🥮 mooncake|🍢 oden|🍡 dango|🍧 shaved ice|🍨 ice cream|🍦 soft serve|🥧 pie|🧁 cupcake|🍰 cake|🎂 birthday|🍮 custard|🍭 lollipop|🍬 candy|🍫 chocolate|🍿 popcorn|🍩 donut|🍪 cookie|🌰 chestnut|🥜 peanuts|🍯 honey|🥛 milk|☕ coffee|🍵 tea|🧋 bubble tea|🥤 soda|🧃 juice|🧊 ice|🍽️ plate|🥄 spoon|🍴 cutlery|🥢 chopsticks'],
  ['Activities', '⚽ soccer football|🏀 basketball|🏈 american football|⚾ baseball|🥎 softball|🎾 tennis|🏐 volleyball|🏉 rugby|🥏 frisbee|🎱 pool billiards|🪀 yoyo|🏓 ping pong|🏸 badminton|🏒 hockey|🥍 lacrosse|🏏 cricket|⛳ golf|🪁 kite|🏹 archery|🎣 fishing|🤿 diving|🥊 boxing|🥋 martial arts|🎽 running|🛹 skateboard|🛼 roller skate|⛸️ ice skate|🥌 curling|🎿 skiing|⛷️ skier|🏂 snowboard|🏋️ lifting|🤼 wrestling|🤸 gymnastics|⛹️ basketball player|🤺 fencing|🏌️ golfer|🏇 jockey|🧗 climbing|🚴 cycling|🏊 swimming|🏄 surfing|🚣 rowing|🏆 trophy|🥇 gold medal|🥈 silver medal|🥉 bronze medal|🏅 medal|🎖️ award|🎗️ ribbon|🎫 ticket|🎟️ tickets|🎪 circus|🤹 juggling|🎭 theater|🎨 painting art|🎬 movies|🎤 mic singing|🎧 headphones music|🎼 music score|🎹 piano|🥁 drum|🎷 saxophone|🎺 trumpet|🎸 guitar|🪕 banjo|🎻 violin|🎲 dice|♟️ chess|🎯 bullseye|🎳 bowling|🎮 video game gaming controller|🕹️ joystick|🎰 slot machine|🧩 puzzle'],
  ['Places', '🚗 car|🚕 taxi|🚙 suv|🚌 bus|🚎 trolleybus|🏎️ race car|🚓 police car|🚑 ambulance|🚒 fire engine|🚚 truck|🚛 lorry|🚜 tractor|🛴 scooter|🚲 bicycle|🛵 motor scooter|🏍️ motorcycle|🚨 emergency|🚔 police|🚍 bus front|🚘 car front|🚖 taxi front|🚡 aerial tramway|🚠 cable car|🚟 suspension railway|🚃 railway car|🚋 tram|🚝 monorail|🚄 train fast|🚅 bullet train|🚈 light rail|🚞 mountain train|🚂 steam train|🚆 train|🚇 subway|🚊 tramway|🚉 station|✈️ airplane|🛫 departure|🛬 arrival|🛩️ plane|💺 seat|🛰️ satellite|🚀 rocket|🛸 ufo|🚁 helicopter|🛶 canoe|⛵ sailboat|🚤 speedboat|🛥️ motor boat|🛳️ passenger ship|⛴️ ferry|🚢 ship|⚓ anchor|⛽ fuel|🚧 construction|🚦 traffic light|🗺️ map|🗿 statue|🗽 liberty|🗼 tower|🏰 castle|🏯 japanese castle|🏟️ stadium|🎡 ferris wheel|🎢 roller coaster|🎠 carousel|⛲ fountain|⛱️ umbrella|🏖️ beach|🏝️ island|🏜️ desert|🌋 volcano|⛰️ mountain|🏔️ snowy mountain|🗻 fuji|🏕️ camping|⛺ tent|🏠 house|🏡 garden home|🏘️ houses|🏚️ abandoned house|🏗️ building|🏭 factory|🏢 office|🏬 store|🏣 post office|🏥 hospital|🏦 bank|🏨 hotel|🏪 convenience store|🏫 school|🏩 love hotel|💒 wedding|🏛️ classical building|⛪ church|🕌 mosque|🛕 temple|🕍 synagogue|🕋 kaaba|🌃 night|🌆 sunset|🌉 bridge'],
  ['Objects', '⌚ watch|📱 phone|💻 laptop|⌨️ keyboard|🖥️ computer|🖨️ printer|🖱️ mouse|💽 disk|💾 floppy save|💿 cd|📀 dvd|📷 camera|📸 photo|📹 video camera|🎥 movie camera|📽️ projector|🎞️ film|📞 telephone|☎️ phone|📺 television|📻 radio|🎙️ microphone|⏱️ stopwatch|⏰ alarm|🕰️ clock|⏳ hourglass|⌛ time|🔋 battery|🔌 plug|💡 bulb idea|🔦 flashlight|🕯️ candle|💰 money|💸 money flying|💵 dollar|💳 credit card|💎 diamond|⚖️ scales|🔧 wrench|🔨 hammer|⚒️ tools|🛠️ tools|⛏️ pickaxe|🪓 axe|🔩 nut bolt|⚙️ gear|🧱 brick|🧲 magnet|🧪 test tube|🔬 microscope|🔭 telescope|💊 medicine|🩹 bandage|🩺 stethoscope|🧸 teddy bear|🎁 gift present|🎈 balloon|🎉 party popper|🎊 confetti|🎀 bow|🪄 magic wand|🪅 pinata|📩 letter|✉️ envelope|📦 package|📚 books|📖 open book|📝 note|✏️ pencil|🖊️ pen|🖌️ paintbrush|🔍 search|🔒 lock|🔓 unlocked|🔑 key|🗝️ old key|📌 pin|📎 paperclip|📏 ruler|✂️ scissors|🗑️ trash|🪑 chair|🛏️ bed|🛋️ couch|🚪 door|🪟 window|🪞 mirror|🛁 bathtub|🚿 shower|🧼 soap'],
  ['Symbols', '❤️ red heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|🤎 brown heart|🩷 pink heart|🩵 light blue heart|🩶 gray heart|💔 broken heart|❤️‍🔥 heart fire|❤️‍🩹 mending heart|💕 two hearts|💞 revolving hearts|💓 beating heart|💗 growing heart|💖 sparkling heart|💘 cupid heart|💝 gift heart|💟 heart decoration|☮️ peace|✝️ cross|☪️ crescent|🕉️ om|☸️ dharma|✡️ david|🔯 star|🕎 menorah|☯️ yin yang|☦️ orthodox|🛐 worship|⛎ ophiuchus|♈ aries|♉ taurus|♊ gemini|♋ cancer|♌ leo|♍ virgo|♎ libra|♏ scorpio|♐ sagittarius|♑ capricorn|♒ aquarius|♓ pisces|🆔 id|⚛️ atom|☢️ radioactive|☣️ biohazard|📴 phone off|📳 vibration|🈶 japanese|🈚 japanese|🆚 versus|💯 hundred|🔞 adults|🚫 prohibited|⛔ no entry|⭕ circle|❌ cross no|✅ check yes|❎ cross box|⚠️ warning|🚸 children|🔱 trident|⚜️ fleur de lis|♻️ recycle|🔰 beginner|💠 diamond dot|Ⓜ️ metro|🅿️ parking|🆗 okay|🆕 new|🆙 up|🆒 cool|🆓 free|🔢 numbers|🔤 letters|➡️ right|⬅️ left|⬆️ up|⬇️ down|↗️ northeast|↘️ southeast|↙️ southwest|↖️ northwest|↔️ horizontal|↕️ vertical|🔄 refresh|↩️ return|↪️ turn|⤴️ turn up|⤵️ turn down|🔀 shuffle|🔁 repeat|🔂 repeat one|▶️ play|⏸️ pause|⏹️ stop|⏺️ record|⏭️ next|⏮️ previous|🔆 bright|🔅 dim|🔊 volume|🔇 mute|🔔 bell|🔕 silent|➕ plus|➖ minus|➗ divide|✖️ multiply|♾️ infinity|❓ question|❗ exclamation|‼️ double exclamation|⁉️ question exclamation|〰️ wave|➰ loop|©️ copyright|®️ registered|™️ trademark|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|🟥 red square|🟧 orange square|🟨 yellow square|🟩 green square|🟦 blue square|🟪 purple square|⬛ black square|⬜ white square|🏁 finish flag|🚩 red flag|🏳️ white flag|🏴 black flag|🏳️‍🌈 rainbow pride flag|🏳️‍⚧️ trans pride flag|🇺🇸 united states usa flag|🇬🇧 united kingdom uk flag|🇨🇦 canada flag|🇲🇽 mexico flag|🇧🇷 brazil flag|🇫🇷 france flag|🇩🇪 germany flag|🇮🇹 italy flag|🇪🇸 spain flag|🇺🇦 ukraine flag|🇯🇵 japan flag|🇰🇷 korea flag|🇨🇳 china flag|🇮🇳 india flag|🇦🇺 australia flag']
].map(([name, values]) => ({ name, items: values.split('|').map(item => { const split = item.indexOf(' '); return { emoji: item.slice(0, split), name: item.slice(split + 1) }; }) }));
App.ensureEmojiPickerLoaded = function () {
  const host = App.$('emoji-picker');
  if (!host || host.dataset.bound === '1') return Promise.resolve();
  host.dataset.bound = '1'; host.classList.add('app-emoji-picker');
  host.innerHTML = '<header class="chat-popup-heading"><div class="chat-popup-heading-copy"><strong>Emoji</strong></div><button type="button" class="chat-popup-close chat-icon-button" aria-label="Close Emoji"><svg viewBox="0 0 24 24" fill="none"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8"/></svg></button></header><div class="emoji-search-wrap"><input class="input emoji-search" type="search" aria-label="Search Emoji" placeholder="Search Emoji" autocomplete="off"></div><div class="emoji-categories" role="group" aria-label="Emoji Categories"></div><div class="emoji-results" role="group" aria-label="Emoji"></div><p class="emoji-empty muted" hidden>No Emoji Found</p>';
  let selected = 0, visiblePage = null;
  const search = host.querySelector('.emoji-search'), categories = host.querySelector('.emoji-categories'), results = host.querySelector('.emoji-results');
  const allItems = EMOJI_GROUPS.flatMap(group => group.items);
  const pages = new Map();
  const makePage = items => {
    const page = document.createElement('div'); page.className = 'emoji-page';
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'emoji-choice'; button.dataset.emoji = item.emoji; button.setAttribute('aria-label', item.name); button.title = item.name;
      const glyph = document.createElement('span'); glyph.className = 'emoji-glyph'; glyph.setAttribute('aria-hidden', 'true'); glyph.textContent = item.emoji;
      button.appendChild(glyph); fragment.appendChild(button);
    }
    page.appendChild(fragment); return page;
  };
  const categoryPage = index => {
    if (!pages.has(index)) pages.set(index, makePage(EMOJI_GROUPS[index].items));
    return pages.get(index);
  };
  const render = () => {
    const query = search.value.trim().toLowerCase();
    const page = query ? makePage(allItems.filter(item => item.name.includes(query) || item.emoji === query)) : categoryPage(selected);
    if (page !== visiblePage) { results.replaceChildren(page); visiblePage = page; results.scrollTop = 0; }
    host.querySelector('.emoji-empty').hidden = page.childElementCount > 0;
    categories.querySelectorAll('button').forEach((button, index) => button.setAttribute('aria-pressed', String(!query && index === selected)));
  };
  EMOJI_GROUPS.forEach((group, index) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'emoji-category'; button.textContent = group.items[0].emoji; button.title = group.name; button.setAttribute('aria-label', group.name); button.onclick = () => { selected = index; search.value = ''; render(); }; categories.appendChild(button); });
  search.addEventListener('input', render);
  results.addEventListener('click', event => { const button = event.target.closest('[data-emoji]'); if (button) App.insertEmojiToComposer(button.dataset.emoji); });
  results.addEventListener('contextmenu', event => { const button = event.target.closest('[data-emoji]'); if (!button) return; event.preventDefault(); event.stopPropagation(); App.openEmojiCtxMenu({ x: event.clientX, y: event.clientY, emoji: button.dataset.emoji, anchor: button }); });
  results.addEventListener('keydown', event => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return; const buttons = [...results.querySelectorAll('button')], index = buttons.indexOf(event.target); if (index < 0) return; event.preventDefault(); const columns = 8; const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key]; const next = buttons[Math.max(0, Math.min(buttons.length - 1, index + step))]; next?.focus({ preventScroll: true }); next?.scrollIntoView({ block:'nearest', inline:'nearest' }); });
  host.querySelector('.chat-popup-close').onclick = App.closeEmojiPopover;
  render(); App.scheduleChatPopoverLayout?.();
  // Prepare detached categories one at a time while idle. Switching pages then
  // reuses their buttons instead of allocating hundreds of nodes per click.
  const idle = globalThis.requestIdleCallback || (callback => setTimeout(callback, 16));
  let warmIndex = 1;
  const warmNext = () => { if (!host.isConnected || warmIndex >= EMOJI_GROUPS.length) return; categoryPage(warmIndex++); idle(warmNext); };
  idle(warmNext);
  return Promise.resolve();
};
App.copyTextToClipboard = function (text) {
  const t = String(text ?? "");
  if (!t) return Promise.resolve();
  return (async () => {
    try {
      await navigator.clipboard.writeText(t);
      return;
    } catch {}
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      if (!document.execCommand("copy")) throw new Error("Clipboard access is unavailable.");
    } finally { ta.remove(); }
  })();
};
App.ensureEmojiCtxMenu = function () {
  if (App.emojiCtxMenu) return App.emojiCtxMenu;
  const el = document.createElement("div");
  el.className = "msg-menu";
  el.id = "emoji-ctx-menu";
  el.style.display = "none";
  el.innerHTML = `
    <button class="msg-menu-btn" id="emoji-ctx-copy" type="button">
      <span class="msg-menu-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M8 8h10v12H8V8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
          <path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </span>
      <span class="msg-menu-label">Copy</span>
    </button>
  `;
  document.body.appendChild(el);
  App.$("emoji-ctx-copy").addEventListener("click", async () => {
    const emoji = el.dataset.emoji || "";
    try { await App.copyTextToClipboard(emoji); }
    catch { App.showToast?.({ title: "Copy Emoji", body: "Clipboard access is unavailable. Try copying from the message field.", duration: 2400 }); }
    finally { App.closeEmojiCtxMenu(); }
  });
  App.emojiCtxMenu = el;
  return el;
};
App.closeEmojiCtxMenu = function (immediate = false) {
  const el = App.emojiCtxMenu;
  if (!el || el.style.display === "none") return;
  if (App.emojiCtxMenuCloseTimer) {
    clearTimeout(App.emojiCtxMenuCloseTimer);
    App.emojiCtxMenuCloseTimer = null;
  }
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (immediate || reduce) {
    el.style.display = "none";
    el.classList.remove("open");
    el.classList.remove("closing");
    App.emojiCtxMenuClosing = false;
    return;
  }
  if (App.emojiCtxMenuClosing) return;
  App.emojiCtxMenuClosing = true;
  el.classList.remove("open");
  el.classList.add("closing");
  const finish = () => {
    App.emojiCtxMenuCloseTimer = null;
    el.style.display = "none";
    el.classList.remove("closing");
    App.emojiCtxMenuClosing = false;
  };
  App.emojiCtxMenuCloseTimer = setTimeout(finish, 140);
};
App.openEmojiCtxMenu = function ({
  x,
  y,
  emoji,
  anchor = null
}) {
  const el = App.ensureEmojiCtxMenu();
  App.closeCallScreenContextMenu?.(true);
  if (App.emojiCtxMenuCloseTimer) {
    clearTimeout(App.emojiCtxMenuCloseTimer);
    App.emojiCtxMenuCloseTimer = null;
  }
  App.emojiCtxMenuClosing = false;
  el.dataset.emoji = String(emoji || "");
  el.style.display = "";
  el.classList.remove("closing");
  el.classList.add("open");
  App.positionContextMenu(el, { x, y, anchor, avoidAnchor: !!anchor });
};
App.insertEmojiToComposer = function (emoji) {
  const input = App.$("msg-input");
  if (!input) return;

  // Always focus + append at end (matches your spec whether focused or not)
  input.focus({ preventScroll: true });
  input.value = String(input.value || "") + String(emoji || "");

  // Trigger existing typing/ping logic
  input.dispatchEvent(new Event("input", {
    bubbles: true
  }));
};
App.closeEmojiPopover = function () {
  const pop = App.$("emoji-popover");
  if (!pop || pop.hidden) return;
  pop.classList.remove("open");
  pop.classList.add("closing");
  App.emojiPopoverOpen = false;
  const motion = App.emojiPopoverMotion = (App.emojiPopoverMotion || 0) + 1;
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finish = () => {
    if (motion !== App.emojiPopoverMotion || App.emojiPopoverOpen) return;
    pop.hidden = true;
    pop.classList.remove("closing");
    App.emojiPopoverOpen = false;
  };
  if (reduce) {
    finish();
    return;
  }
  setTimeout(finish, 200);
};
App.openEmojiPopover = function () {
  const pop = App.$('emoji-popover'); if (!pop) return;
  App.closeRoomActivitiesMenu?.(); App.closeStickerPopover?.({ immediate: true });
  App.closeVoicePopover?.(); App.closeComposerMoreMenu?.({ immediate: true });
  App.ensureEmojiPickerLoaded();
  const motion = App.emojiPopoverMotion = (App.emojiPopoverMotion || 0) + 1;
  pop.hidden = false; pop.classList.remove('closing'); App.emojiPopoverOpen = true;
  App.layoutChatPopovers?.();
  requestAnimationFrame(() => { if (motion === App.emojiPopoverMotion && App.emojiPopoverOpen) pop.classList.add('open'); });
};
App.toggleEmojiPopover = function () {
  const placeNow = App.getStoredPlace() || "home";

  // Composer emoji picker only inside rooms (chat rooms)
  if (!App.currentRoomId || !placeNow.startsWith("room:") || App.views.chat.dataset.active !== "true") {
    App.showToast({
      title: "Pick a room",
      body: "Create or join a room first.",
      duration: 2200
    });
    return;
  }
  if (App.emojiPopoverOpen) App.closeEmojiPopover();else void App.openEmojiPopover();
};
App.isActiveChatRoomForMembersToggle = function () {
  const placeNow = App.getStoredPlace() || "home";
  return !!App.currentRoomId && placeNow.startsWith("room:") && App.views.chat.dataset.active === "true";
};
App.toggleMembersListVisibility = function () {
  if (!App.isActiveChatRoomForMembersToggle()) return false;
  App.closeEmojiCtxMenu();
  App.membersListVisible = !App.membersListVisible;
  App.syncEmojiButtonVisibility();
  return true;
};
App.closeComposerMoreMenu = function ({
  immediate = false
} = {}) {
  const menu = App.$("composer-more-menu");
  const button = App.$("btn-composer-more");
  if (!menu) return;
  App.composerMoreOpen = false;
  button?.setAttribute("aria-expanded", "false");
  menu.classList.remove("open");
  menu.classList.toggle("closing", !immediate);
  const finish = () => {
    if (App.composerMoreOpen) return;
    menu.hidden = true;
    menu.classList.remove("closing");
  };
  if (immediate) finish();else setTimeout(finish, 160);
};
App.openComposerMoreMenu = function () {
  const menu = App.$("composer-more-menu");
  const button = App.$("btn-composer-more");
  if (!menu || !button || button.hidden) return;
  if (App.voicePopoverOpen && App.voiceRecorder) return;
  App.closeEmojiPopover();
  App.closeVoicePopover();
  App.closeStickerPopover();
  menu.hidden = false;
  menu.classList.remove("closing");
  App.composerMoreOpen = true;
  App.layoutChatPopovers?.();
  button.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    if (App.composerMoreOpen) menu.classList.add("open");
  });
};
App.toggleComposerMoreMenu = function () {
  if (App.composerMoreOpen) App.closeComposerMoreMenu();else App.openComposerMoreMenu();
};
App.getComposerDirectToolCount = function (width, toolCount = App.COMPOSER_OPTIONAL_TOOL_IDS.length) {
  const w = Math.max(0, Number(width) || 0);
  const count = Math.max(0, Number(toolCount) || 0);
  const capacity = w >= 760 ? 5 : w >= 650 ? 4 : w >= 540 ? 3 : w >= 440 ? 2 : w >= 0 ? 1 : 0;
  const direct = Math.min(count, capacity);
  // The last tool uses exactly the space occupied by the More Tools button.
  // Keep it directly accessible instead of replacing it with a one-item menu.
  return count - direct === 1 ? count : direct;
};
App.syncComposerToolLayout = function () {
  const row = App.$("composer-row");
  const direct = App.$("composer-actions-direct");
  const overflow = App.$("composer-more-actions");
  const more = App.$("btn-composer-more");
  if (!row || !direct || !overflow || !more) return;
  const placeNow = App.getStoredPlace() || "home";
  const inRoom = !!App.currentRoomId && placeNow.startsWith("room:") && App.views.chat.dataset.active === "true";
  const tools = App.COMPOSER_OPTIONAL_TOOL_IDS.map(id => App.$(id)).filter(Boolean);
  const visibleTools = inRoom ? tools.filter(tool => !tool.hidden) : [];
  const directCount = inRoom ? App.getComposerDirectToolCount(row.getBoundingClientRect().width, visibleTools.length) : 0;
  const directTools = new Set(visibleTools.slice(0, directCount));
  tools.forEach(tool => {
    const destination = tool.hidden || directTools.has(tool) ? direct : overflow;
    if (tool.parentElement !== destination) destination.appendChild(tool);
    tool.dataset.composerLocation = destination === overflow ? "overflow" : "direct";
    if (destination === overflow) tool.setAttribute("role", "menuitem");else tool.removeAttribute("role");
  });

  // Re-appending in canonical order keeps the menu predictable while the
  // breakpoint moves one button at a time between the two containers.
  for (const host of [direct, overflow]) {
    App.COMPOSER_OPTIONAL_TOOL_IDS.forEach(id => {
      const tool = App.$(id);
      if (tool?.parentElement === host) host.appendChild(tool);
    });
  }
  const overflowCount = visibleTools.length - directCount;
  more.hidden = overflowCount === 0;
  if (!overflowCount) App.closeComposerMoreMenu({
    immediate: true
  });
};
App.bindResponsiveComposerOnce = function () {
  const row = App.$("composer-row");
  if (!row || row.dataset.responsiveBound === "1") return;
  row.dataset.responsiveBound = "1";
  App.$("btn-composer-more")?.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    App.toggleComposerMoreMenu();
  });
  App.$("composer-more-actions")?.addEventListener("click", event => {
    if (!event.target?.closest?.(".composer-tool-btn")) return;
    requestAnimationFrame(() => App.closeComposerMoreMenu());
  }, {
    capture: true
  });
  if (typeof ResizeObserver === "function") {
    App.composerLayoutObserver = new ResizeObserver(() => App.syncComposerToolLayout());
    App.composerLayoutObserver.observe(row);
  } else {
    window.addEventListener("resize", App.syncComposerToolLayout, {
      passive: true
    });
  }
  App.syncComposerToolLayout();
};
App.syncEmojiButtonVisibility = function () {
  const eBtn = App.$("btn-emoji");
  const sBtn = App.$("btn-stickers");
  const aBtn = App.$("btn-activities");
  const vBtn = App.$("btn-voice");
  const mBtn = App.$("btn-members");
  const membersSidebar = App.$("members-sidebar");
  if (!eBtn && !sBtn && !aBtn && !vBtn && !mBtn && !membersSidebar) return;
  const placeNow = App.getStoredPlace() || "home";
  const inRoom = !!App.currentRoomId && placeNow.startsWith("room:") && App.views.chat.dataset.active === "true";
  const showMembersSidebar = inRoom && App.membersListVisible;
  document.body.dataset.roomView = inRoom ? "1" : "0";
  document.body.dataset.membersSidebar = showMembersSidebar ? "1" : "0";
  if (eBtn) eBtn.hidden = !inRoom;
  if (sBtn) sBtn.hidden = !inRoom;
  if (aBtn) aBtn.hidden = !inRoom;
  if (vBtn) vBtn.hidden = !inRoom;
  if (mBtn) mBtn.hidden = !inRoom;
  if (mBtn) mBtn.setAttribute("aria-expanded", showMembersSidebar ? "true" : "false");
  if (membersSidebar) membersSidebar.hidden = !showMembersSidebar;
  App.syncCompanionMembersButton?.();
  if (!inRoom) {
    App.membersListVisible = document.body.dataset.mobileUi === "1" ? false : true;
    App.closeEmojiCtxMenu(true);
    App.closeEmojiPopover();
    App.closeStickerPopover();
    App.closeVoicePopover({
      keepRecorder: false
    });
  }
  App.syncRoomActivitiesButton();
  App.syncComposerToolLayout();
};
App.closeMobileDrawers = function () {
  document.body.dataset.mobileNav = "0";
  App.$("btn-mobile-nav")?.setAttribute("aria-expanded", "false");
  if (document.body.dataset.mobileUi === "1" && App.membersListVisible) {
    App.membersListVisible = false;
    App.syncEmojiButtonVisibility();
  }
};

App.register("chat/emoji", function initializeFeature() {
App.emojiPopoverOpen = false;
App.emojiCtxMenu = null;
App.emojiCtxMenuClosing = false;
App.emojiCtxMenuCloseTimer = null;
App.emojiPickerLoadPromise = null;
App.membersListVisible = document.body.dataset.mobileUi === "1" ? false : true;
App.COMPOSER_OPTIONAL_TOOL_IDS = ["btn-stickers", "btn-emoji", "btn-voice", "btn-poll"];
App.stickerPopoverOpen = false;
App.composerMoreOpen = false;
App.composerLayoutObserver = null;
App.bindResponsiveComposerOnce();
App.$("btn-emoji")?.addEventListener("click", e => {
  e.preventDefault();
  e.stopPropagation();
  App.closeEmojiCtxMenu();
  App.toggleEmojiPopover();
});
App.$("btn-activities")?.addEventListener("click", e => {
  e.preventDefault();
  e.stopPropagation();
  App.closeEmojiCtxMenu();
  const headerRoom = App.$("room-toolbar")?.classList.contains("in-call") && App.currentCallRoomId;
  if (headerRoom && headerRoom !== App.currentRoomId) {
    void App.openRoom(headerRoom, { quiet: true }).then(() => App.openRoomActivitiesModal());
    return;
  }
  App.openRoomActivitiesModal();
});
App.$("btn-voice")?.addEventListener("click", e => {
  e.preventDefault();
  e.stopPropagation();
  App.closeEmojiCtxMenu();
  App.toggleVoicePopover();
});
App.$("btn-members")?.addEventListener("click", e => {
  e.preventDefault();
  e.stopPropagation();
  document.body.dataset.mobileNav = "0";
  App.$("btn-mobile-nav")?.setAttribute("aria-expanded", "false");
  const headerRoom = App.$("room-toolbar")?.classList.contains("in-call") && App.currentCallRoomId;
  if (headerRoom && headerRoom !== App.currentRoomId) {
    void App.openRoom(headerRoom, { quiet: true }).then(() => {
      App.membersListVisible = true;
      App.syncEmojiButtonVisibility();
    });
    return;
  }
  App.toggleMembersListVisibility();
});
App.$("btn-mobile-nav")?.addEventListener("click", e => {
  e.preventDefault();
  e.stopPropagation();
  if (document.body.dataset.mobileUi !== "1") return;
  if (App.membersListVisible) {
    App.membersListVisible = false;
    App.syncEmojiButtonVisibility();
  }
  const open = document.body.dataset.mobileNav !== "1";
  document.body.dataset.mobileNav = open ? "1" : "0";
  e.currentTarget.setAttribute("aria-expanded", open ? "true" : "false");
});
App.$("mobile-drawer-scrim")?.addEventListener("click", App.closeMobileDrawers);
document.addEventListener("click", e => {
  if (document.body.dataset.mobileNav !== "1") return;
  if (!e.target?.closest?.(".sidebar:not(.members-sidebar) .side-btn, .sidebar:not(.members-sidebar) .room-row, .sidebar:not(.members-sidebar) .time-display-card")) return;
  App.closeMobileDrawers();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && document.body.dataset.mobileUi === "1") App.closeMobileDrawers();
});
document.addEventListener("keydown", e => {
  if (e.repeat) return;
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
  if (String(e.key || "").toLowerCase() !== "u") return;
  if (!App.isActiveChatRoomForMembersToggle()) return;
  e.preventDefault();
  e.stopPropagation();
  App.toggleMembersListVisibility();
});
document.addEventListener("pointerdown", e => {
  const ePop = App.$("emoji-popover");
  const eBtn = App.$("btn-emoji");
  const vPop = App.$("voice-popover");
  const vBtn = App.$("btn-voice");
  const composerMore = App.$("composer-more-menu");
  const composerMoreBtn = App.$("btn-composer-more");
  if (App.composerMoreOpen && composerMore) {
    const target = e.target;
    if (!composerMore.contains(target) && !composerMoreBtn?.contains(target)) App.closeComposerMoreMenu();
  }
  if (App.emojiCtxMenu && App.emojiCtxMenu.style.display !== "none") {
    const inside = App.emojiCtxMenu.contains(e.target);
    if (!inside) App.closeEmojiCtxMenu();
  }
  if (App.emojiPopoverOpen && ePop && !ePop.hidden) {
    const target = e.target;
    const insideEmoji = ePop.contains(target);
    const onEmojiBtn = eBtn && eBtn.contains(target);
    const insideCtx = App.emojiCtxMenu && App.emojiCtxMenu.style.display !== "none" && App.emojiCtxMenu.contains(target);
    if (!insideEmoji && !onEmojiBtn && !insideCtx) App.closeEmojiPopover();
  }
  if (App.voicePopoverOpen && vPop && !vPop.hidden) {
    const target = e.target;
    const insideVoice = vPop.contains(target);
    const onVoiceBtn = vBtn && vBtn.contains(target);
    if (!insideVoice && !onVoiceBtn && !App.voiceRecorder) App.closeVoicePopover();
  }
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (App.emojiPopoverOpen) App.closeEmojiPopover();
  if (App.voicePopoverOpen) App.closeVoicePopover({
    keepRecorder: false
  });
  if (App.composerMoreOpen) App.closeComposerMoreMenu();
  App.closeEmojiCtxMenu();
});
});
})(globalThis.ChatApp);
