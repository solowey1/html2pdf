require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const handlebars = require('handlebars');
const AWS = require('aws-sdk');
const { customAlphabet } = require('nanoid');
const axios = require('axios');

// Настройка лимитера
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // Ограничение каждого IP 100 запросами на окно
  message: "Слишком много запросов с вашего IP, пожалуйста, попробуйте позже."
});

// Middleware для проверки API ключа
async function verifyApiKey(req, res, next) {
    const apiKey = req.headers.authorization?.split(' ')[1];

    if (!apiKey) {
        return res.status(401).json({ error: 'API ключ отсутствует' });
    }

    try {
        const result = await pool.query('SELECT * FROM users WHERE api_key = $1', [apiKey]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Недействительный API ключ' });
        }

        // Сохраняем информацию о пользователе в запросе для дальнейшего использования
        req.user = result.rows[0];

        next();
    } catch (err) {
        console.error(err.message);
        return res.status(500).send('Ошибка сервера при проверке API ключа');
    }
}

const pool = new Pool({
  user: process.env.POSTGRES_ROLE,
  host: 'localhost',
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PWD,
  port: process.env.POSTGRES_PORT,
});

// Функция для выполнения запросов к БД
const query = (text, params) => pool.query(text, params);


const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 10);

// Функция для проверки уникальности и генерации имени файла
async function generateUniqueFileName(prefix) {
    let unique = false;
    let fileName;

    while (!unique) {
        const id = nanoid();
        fileName = `${prefix}-${id}.pdf`;

        // Проверьте, существует ли уже такое имя файла
        unique = !await isFileNameExists(fileName);
    }

    // Здесь код для сохранения имени файла в хранилище
    // ...

    return fileName;
}

// Функция для проверки существования файла (пример с файлом, может быть база данных и т.п.)
async function isFileNameExists(fileName) {
    // Здесь логика проверки наличия имени файла в вашем хранилище
    // ...
}

// Настройка AWS S3 для Yandex Cloud Object Storage
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    endpoint: process.env.S3_ENDPOINT,
    s3ForcePathStyle: true,
    signatureVersion: 'v4'
});

const app = express();
app.use(cors()); // Использование CORS
app.use('/api/', apiLimiter); // Применение лимитера к API
app.use('/api/', verifyApiKey); // Применение middleware к вашим маршрутам
app.use(morgan('combined')); // 'combined' предоставляет детальные логи
app.use(bodyParser.json());

// Функция для шаблонизации HTML
function applyTemplate(html, variables) {
    const template = handlebars.compile(html);
    return template(variables);
}

// Функция для генерации PDF
async function generatePDF(html) {
    const browser = await puppeteer.launch({headless: "new"});
    const page = await browser.newPage();
    await page.setContent(html);
    const pdfBuffer = await page.pdf({ format: 'A4' });
    await browser.close();
    return pdfBuffer;
}

// Функция для загрузки файла в S3
async function uploadToS3(bucketName, fileName, pdfBuffer) {
    const params = {
        Bucket: bucketName,
        Key: fileName,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
        ACL: 'public-read'
    };

    try {
        const data = await s3.upload(params).promise();
        return data.Location;
    } catch (err) {
        throw new Error(`Failed to upload file to S3: ${err.message}`);
    }
}

// Обработка POST-запроса на /api/pdf/create
app.post('/api/pdf/create', async (req, res) => {
    try {
        const { file, vars, name } = req.body;
        let htmlContent = file.content ? applyTemplate(file.content, vars) : '';

        if (file.url) {
            const response = await axios.get(file.url);
            htmlContent = applyTemplate(response.data, vars);
        }

        // Генерация уникального имени файла
        const pdfName = name ? await generateUniqueFileName(name) : `html2pdf-${nanoid()}.pdf`;
        const pdfBuffer = await generatePDF(htmlContent);
        const pdfUrl = await uploadToS3(process.env.S3_BUCKET_NAME, pdfName, pdfBuffer);

        res.status(200).send({ pdfUrl });
    } catch (error) {
        console.error('Error: ', error);
        res.status(500).send('Internal Server Error');
    }
});

app.post('/generate-api-key', async (req, res) => {
    // Предполагаем, что пользователь уже аутентифицирован и его ID доступен
    const userId = req.user.id; // Замените на вашу логику получения ID пользователя

    try {
        const newApiKey = uuidv4();

        // Обновление API ключа в базе данных для пользователя
        await pool.query('UPDATE users SET api_key = $1 WHERE id = $2', [newApiKey, userId]);

        res.json({ apiKey: newApiKey });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Ошибка сервера');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
