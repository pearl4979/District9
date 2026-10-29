'use strict';
// An address receives one supplied portrait consistently across views/devices.
window.AgentWalletAvatar=(()=>{
 const key=address=>typeof address==='string'&&/^0x[0-9a-f]{40}$/i.test(address.trim())?address.trim().toLowerCase():'district9:unknown-wallet';
 function defaultPath(address){let seed=2166136261;for(const char of key(address))seed=Math.imul(seed^char.charCodeAt(0),16777619)>>>0;return `/assets/wallet-default-${seed%6+1}.png`;}
 function createDefault(address){const img=document.createElement('img');img.className='wallet-default-avatar';img.src=defaultPath(address);img.alt='';img.decoding='async';return img;}
 function verified(wallet){const s=wallet?.social;return s?.status==='verified'&&/^0x[0-9a-f]{40}$/i.test(wallet.address||'')&&s.address?.toLowerCase()===key(wallet.address)&&/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(s.xUrl||'')?s:null;}
 function create(wallet={}){const img=createDefault(wallet.address),social=verified(wallet),custom=/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(wallet.avatar||'')&&wallet.avatar.length<=6500?wallet.avatar:null;
  const src=(social?.avatarPath===`/api/wallet-avatar/${key(wallet.address)}`?social.avatarPath:null)||custom;if(src){img.className='wallet-profile-avatar';img.src=src;let failed=false;img.addEventListener('error',()=>{if(failed)return;failed=true;img.className='wallet-default-avatar';img.src=defaultPath(wallet.address);});}return img;
 }
 return{createDefault,create,verified};
})();
