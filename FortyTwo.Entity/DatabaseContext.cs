﻿using FortyTwo.Entity.Mappings;
using FortyTwo.Entity.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Npgsql;

namespace FortyTwo.Entity
{
    public class DatabaseContext : DbContext
    {
        private readonly NpgsqlConnection _pgsqlConnection;

        public DatabaseContext(DbContextOptions<DatabaseContext> options)
           : base(options)
        { }

        public DatabaseContext(IConfiguration configuration)
        {
            var databaseUri = new Uri(configuration["DATABASE_URL"]);
            var userInfo = databaseUri.UserInfo.Split(':');

            var builder = new NpgsqlConnectionStringBuilder
            {
                Host = databaseUri.Host,
                Port = databaseUri.Port,
                Username = userInfo[0],
                Password = userInfo[1],
                Database = databaseUri.LocalPath.TrimStart('/')
            };

            _pgsqlConnection = new NpgsqlConnection(builder.ToString());
        }

        protected override void OnConfiguring(DbContextOptionsBuilder options)
        {
            if (_pgsqlConnection != null)
            {
                options.UseNpgsql(_pgsqlConnection, options => options.EnableRetryOnFailure());
            }

            base.OnConfiguring(options);
        }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.ApplyConfiguration(new MatchMap());
            modelBuilder.ApplyConfiguration(new MatchPlayerMap());
        }

        public DbSet<Match> Matches { get; set; }
        public DbSet<MatchPlayer> MatchPlayers { get; set; }
    }
}