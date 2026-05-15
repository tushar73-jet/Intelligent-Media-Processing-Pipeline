const fs = require('fs');
const sharp = require('sharp');
sharp({
  create: {
    width: 400,
    height: 200,
    channels: 3,
    background: { r: 255, g: 255, b: 255 }
  }
})
.jpeg()
.toFile('/tmp/test_plate.jpg')
.then(() => console.log('Successfully generated test JPEG'))
.catch(console.error);
