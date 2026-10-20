// Satu proses berisi API + worker. Dipakai di Render, di mana satu web service
// menjalankan semuanya. Untuk skala lebih besar, jalankan worker sebagai service terpisah.
await import('./index');
await import('./worker/index');
export {};
