using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace FortyTwo.Entity.Migrations
{
    public partial class Initial : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "matches",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    current_game_json = table.Column<string>(type: "jsonb", nullable: true),
                    games_json = table.Column<string>(type: "jsonb", nullable: true),
                    winning_team = table.Column<int>(type: "integer", nullable: true),
                    created_on = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_on = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_matches", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "match_players",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    match_id = table.Column<Guid>(type: "uuid", nullable: false),
                    player_id = table.Column<string>(type: "text", nullable: false),
                    position = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_match_players", x => x.Id);
                    table.ForeignKey(
                        name: "FK_match_players_matches_match_id",
                        column: x => x.match_id,
                        principalTable: "matches",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_match_players_match_id",
                table: "match_players",
                column: "match_id");

            migrationBuilder.CreateIndex(
                name: "IX_match_players_player_id",
                table: "match_players",
                column: "player_id");

            migrationBuilder.CreateIndex(
                name: "IX_matches_created_on",
                table: "matches",
                column: "created_on");

            migrationBuilder.CreateIndex(
                name: "IX_matches_updated_on",
                table: "matches",
                column: "updated_on");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "match_players");

            migrationBuilder.DropTable(
                name: "matches");
        }
    }
}
