using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.ViewModels;
using FortyTwo.Shared.Extensions;
using FortyTwo.Shared.Models;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.SignalR.Client;
using System;
using System.Linq;
using System.Threading.Tasks;

namespace FortyTwo.Client.Pages
{
    public partial class Match : IAsyncDisposable
    {
        [Parameter]
        public Guid MatchId { get; set; }

        [Inject]
        public IMatchViewModel Model { get; set; }

        [Inject]
        public SweetAlertService Swal { get; set; }

        [Inject]
        public NavigationManager NavigationManager { get; set; }

        [Inject]
        public HubConnection HubConnection { get; set; }

        protected override async Task OnInitializedAsync()
        {
            Model.Initialize(MatchId);

            if (Model.Player == null)
            {
                await Model.FetchPlayerAsync();
            }

            if (Model.CurrentGame == null)
            {
                await Model.FetchMatchAsync();
            }

            // TODO: add a visual indicator of the match being over

            // TODO: add a visual indicator of connected status

            // TODO: handle signalr connection exceptions

            HubConnection.Reconnected += async (string connectionId) =>
            {
                await Model.FetchMatchAsync();
            };

            HubConnection.On<FortyTwo.Shared.DTO.Match>("OnMatchChanged", async (match) =>
            {
                var newGameStarting = Model.CurrentGame.Id != match.CurrentGame.Id;

                await Model.UpdateMatch(match);
                await Model.FetchPlayerAsync();

                StateHasChanged();

                if (newGameStarting)
                {
                    await Swal.FireAsync(new SweetAlertOptions
                    {
                        Icon = SweetAlertIcon.Info,
                        Toast = true,
                        ShowConfirmButton = false,
                        Timer = 1750,
                        TimerProgressBar = true,
                        ShowCloseButton = false,
                        Title = "The next game has started",
                    });
                }
                else if (match.WinningTeam.HasValue)
                {
                    var alertOptions = new SweetAlertOptions
                    {
                        ShowConfirmButton = true,
                        ConfirmButtonText = "OK",
                        FocusConfirm = true,
                        ShowCancelButton = false,
                        ShowCloseButton = false,
                    };

                    var biddingTeam = (int)Model.Match.Players.First(x => x.Id == Model.CurrentGame.BiddingPlayerId).Position % 2 == 0
                        ? Teams.TeamA
                        : Teams.TeamB;

                    if (Model.Player.Team == match.WinningTeam)
                    {
                        alertOptions.Icon = SweetAlertIcon.Success;
                        alertOptions.Title = "Victory!";
                        alertOptions.Text = "Your team won the match! 🥳🎈";
                    }
                    else
                    {
                        alertOptions.Icon = SweetAlertIcon.Error;
                        alertOptions.Title = "Game Over!";
                        alertOptions.Text = "The other team won the match 😭...";
                    }

                    await Swal.FireAsync(alertOptions);
                }
            });

            HubConnection.On<FortyTwo.Shared.DTO.Game>("OnGameChanged", async (game) =>
            {
                if (Model.CurrentGame.CurrentTrick.Dominos.Count(x => x != null) == 3 && game.CurrentTrick.Dominos.All(x => x == null))
                {
                    Model.CurrentGame.CurrentTrick.AddDomino(game.Tricks.Last().Dominos.Last(), Model.CurrentGame.Trump.Value);

                    StateHasChanged();

                    await Task.Delay(1000);
                }

                await Model.UpdateGame(game);

                StateHasChanged();

                await ShowNotificationIfGameOverAsync(game);
            });

            await HubConnection.SendAsync("JoinGameAsync", MatchId);
        }

        public async ValueTask DisposeAsync()
        {
            await HubConnection?.SendAsync("LeaveGameAsync", MatchId);
        }

        public bool IsConnected =>
            HubConnection.State == HubConnectionState.Connected;

        public async Task ShowNotificationIfGameOverAsync(FortyTwo.Shared.DTO.Game game)
        {
            if (!game.WinningTeam.HasValue) return;

            var alertOptions = new SweetAlertOptions
            {
                ShowConfirmButton = true,
                ConfirmButtonText = "OK",
                FocusConfirm = true,
                ShowCancelButton = false,
                ShowCloseButton = false,
            };

            var biddingTeam = (int)Model.Match.Players.First(x => x.Id == Model.CurrentGame.BiddingPlayerId).Position % 2 == 0
                ? Teams.TeamA
                : Teams.TeamB;

            if (Model.Player.Team == game.WinningTeam)
            {
                alertOptions.Icon = SweetAlertIcon.Success;
                alertOptions.Title = "Victory!";
                alertOptions.Text = biddingTeam == Model.Player.Team
                    ? "Your team made their bid! 🥳🎈"
                    : "You set the other team! 🎉";
            }
            else
            {
                alertOptions.Icon = SweetAlertIcon.Error;
                alertOptions.Title = "Game Over!";
                alertOptions.Text = biddingTeam == Model.Player.Team
                    ? "The other team set you 😡"
                    : "The other team made their bid 😒";
            }

            await Swal.FireAsync(alertOptions);
        }

        public async Task BidAsync(Bid bid)
        {
            var error = await Model.BidAsync(bid);

            if (error != null)
            {
                await Swal.FireAsync(new SweetAlertOptions
                {
                    Icon = SweetAlertIcon.Error,
                    Title = error.Title,
                    Html = error.Detail.Truncate(250),
                    ConfirmButtonText = "Ok",
                });
            }
        }

        public async Task UpdatePlayerAsync(bool ready)
        {
            var error = await Model.UpdatePlayerAsync(ready);

            if (error != null)
            {
                await Swal.FireAsync(new SweetAlertOptions
                {
                    Icon = SweetAlertIcon.Error,
                    Title = error.Title,
                    Html = error.Detail.Truncate(250),
                    ConfirmButtonText = "Ok",
                });
            }
        }


        public async Task SelectTrumpAsync(Suit suit)
        {
            var error = await Model.SelectTrumpAsync(suit);

            if (error != null)
            {
                await Swal.FireAsync(new SweetAlertOptions
                {
                    Icon = SweetAlertIcon.Error,
                    Title = error.Title,
                    Html = error.Detail.Truncate(250),
                    ConfirmButtonText = "Ok",
                });
            }
        }

        public async Task MakeMoveAsync(Domino domino)
        {
            var error = await Model.MakeMoveAsync(domino);

            if (error != null)
            {
                await Swal.FireAsync(new SweetAlertOptions
                {
                    Icon = SweetAlertIcon.Error,
                    Title = error.Title,
                    Html = error.Detail.Truncate(250),
                    ConfirmButtonText = "Ok",
                });
            }
        }
    }
}
