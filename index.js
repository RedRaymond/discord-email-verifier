const { Client, GatewayIntentBits, Partials, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Cache for temporary OTPs: userId -> { code, email, expiresAt }
const pendingVerifications = new Map();

client.once('ready', () => {
  console.log(`Verification bot logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'verify-email') {
    const email = interaction.options.getString('email').trim().toLowerCase();
    const userId = interaction.user.id;

    // Check if email is already linked in Supabase
    const { data: existingUser, error: checkError } = await supabase
      .from('verified_users')
      .select('user_id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return interaction.reply({
        content: 'This email address is already registered to a verified account.',
        ephemeral: true
      });
    }

    // Generate 6-digit OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    pendingVerifications.set(userId, {
      code,
      email,
      expiresAt: Date.now() + 10 * 60 * 1000 // 10 min expiry
    });

    try {
      await transporter.sendMail({
        from: `"Community Verification" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Your Community Verification Code',
        text: `Your verification code is: ${code}\nThis code will expire in 10 minutes.`
      });

      await interaction.reply({
        content: `A verification code has been sent to **${email}**. Use \`/submit-code\` with your 6-digit code to complete verification.`,
        ephemeral: true
      });
    } catch (err) {
      console.error('Mail delivery error:', err);
      await interaction.reply({
        content: 'Failed to send verification email. Please contact server administrators.',
        ephemeral: true
      });
    }
  }

  if (commandName === 'submit-code') {
    const enteredCode = interaction.options.getString('code').trim();
    const userId = interaction.user.id;
    const session = pendingVerifications.get(userId);

    if (!session) {
      return interaction.reply({
        content: 'No active verification process found. Start with `/verify-email`.',
        ephemeral: true
      });
    }

    if (Date.now() > session.expiresAt) {
      pendingVerifications.delete(userId);
      return interaction.reply({
        content: 'Your verification code has expired. Request a new one using `/verify-email`.',
        ephemeral: true
      });
    }

    if (session.code !== enteredCode) {
      return interaction.reply({
        content: 'Incorrect verification code. Please check and try again.',
        ephemeral: true
      });
    }

    // Save record to Supabase
    const { error: insertError } = await supabase
      .from('verified_users')
      .insert([{ user_id: userId, email: session.email, verified_at: new Date().toISOString() }]);

    if (insertError) {
      console.error('Database write error:', insertError);
      return interaction.reply({
        content: 'Verification failed during database sync. Please notify an administrator.',
        ephemeral: true
      });
    }

    // Assign verified role
    try {
      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      const member = await guild.members.fetch(userId);
      await member.roles.add(process.env.VERIFIED_ROLE_ID);

      pendingVerifications.delete(userId);

      await interaction.reply({
        content: '✅ Verification successful! Your verified server role has been granted.',
        ephemeral: true
      });
    } catch (err) {
      console.error('Role assignment error:', err);
      await interaction.reply({
        content: 'Email verified, but failed to assign the role automatically. Please notify a moderator.',
        ephemeral: true
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
