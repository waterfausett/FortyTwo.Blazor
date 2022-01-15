using BlazorSortableJS.Components;
using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.Services;
using FortyTwo.Client.Store;
using FortyTwo.Shared.DTO;
using FortyTwo.Shared.Models;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.SignalR.Client;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Game = FortyTwo.Shared.DTO.Game;

namespace FortyTwo.Client.Pages
{
    public partial class Match : IAsyncDisposable
    {
        [Parameter] public Guid MatchId { get; set; }
        [Inject] public SweetAlertService Swal { get; set; }
        [Inject] public NavigationManager NavigationManager { get; set; }
        [Inject] public HubConnection HubConnection { get; set; }
        [Inject] public IClientStore Store { get; set; }
        [Inject] public IApiClient ApiClient { get; set; }

        private bool _fetchingGame;
        private bool _fetchingPlayer;
        public bool IsLoading => _fetchingGame || _fetchingPlayer;
        public bool Bidding { get; set; }
        public bool MakingMove { get; set; }
        public FortyTwo.Shared.DTO.Match Model
        {
            get => Store.Matches?.Values.FirstOrDefault(x => x.Id == MatchId);
        }

        public Game CurrentGame
        {
            get => Model?.CurrentGame;
        }

        public LoggedInPlayer Player { get; set; }

        public List<Bid> BiddingOptions
        {
            get
            {
                var biddingOptions = Enum.GetValues(typeof(Bid)).OfType<Bid>().ToList();
                if (Player.Dominos.Count(x => x.IsDouble) < 4)
                {
                    biddingOptions.Remove(Bid.Plunge);
                }

                // HACK: always remove this option until it's fully supported in the rest of the app
                biddingOptions.Remove(Bid.Plunge);

                if (CurrentGame.Bid.HasValue)
                {
                    biddingOptions.RemoveAll(x => (x != Bid.Pass && x != Bid.Plunge) && x <= CurrentGame.Bid.Value);
                }

                if (CurrentGame.Hands.Count(x => x.Bid == Bid.Pass) == 3)
                {
                    biddingOptions.Remove(Bid.Pass);
                }

                biddingOptions.RemoveAll(x => x > Bid.EightyFour && (!CurrentGame.Bid.HasValue || (int)x > ((int)CurrentGame.Bid + (int)Bid.FourtyTwo)));

                return biddingOptions;
            }
        }

        private SortGroup<Domino> MyGroup;

        public async Task OnSort(SortableEvent<Domino> e)
        {
            await e.Sender.GetOrderListAsync("Order");
            Player.Dominos = Player.Dominos.OrderBy(x => x.Order).ToList();
        }

        public bool IsConnected =>
            HubConnection.State == HubConnectionState.Connected;

        protected override async Task OnInitializedAsync()
        {
            // TODO: add a visual indicator of the match being over

            // TODO: add a visual indicator of connected status

            if (Player == null)
            {
                await FetchPlayerAsync();
            }

            if (CurrentGame == null)
            {
                await FetchMatchAsync();
            }

            await RegisterSignalRAsync();
        }

        public async Task FetchMatchAsync()
        {
            _fetchingGame = true;

            try
            {
                await ApiClient.FetchMatchAsync(MatchId);

                await UpdateGame(Model.CurrentGame);
            }
            finally
            {
                _fetchingGame = false;
            }
        }

        public async Task UpdateGame(Game game)
        {
            Model.CurrentGame = game;

            Player.Bid ??= game.Hands.First(x => x.PlayerId == Player.Id).Bid;
            Player.IsActive = game.CurrentPlayerId == Player.Id;

            if (game.WinningTeam.HasValue)
            {
                await FetchPlayerAsync();
            }
        }

        public async Task FetchPlayerAsync()
        {
            _fetchingPlayer = true;

            try
            {
                Player = await ApiClient.FetchMatchPlayerAsync(MatchId);
                if (MyGroup != null)
                {
                    await MyGroup.UpdateAsync();
                }
            }
            finally
            {
                _fetchingPlayer = false;
            }
        }

        public async Task UpdatePlayerAsync(bool ready)
        {
            if (await ApiClient.UpdateMatchPlayerAsync(MatchId, ready))
            {
                Player.Ready = ready;
            }
        }

        public async Task BidAsync(Bid bid)
        {
            Bidding = true;

            try
            {
                if (await ApiClient.BidAsync(MatchId, bid))
                { 
                    Player.Bid = bid;
                }
            }
            finally
            {
                Bidding = false;
            }
        }

        public async Task SelectTrumpAsync(Suit suit)
        {
            Bidding = true;

            try
            {
                await ApiClient.SelectTrumpAsync(MatchId, suit);
            }
            finally
            {
                Bidding = false;
            }
        }

        public async Task MakeMoveAsync(Domino domino)
        {
            MakingMove = true;

            var currentPlayerId = CurrentGame.CurrentPlayerId;
            try
            {
                CurrentGame.CurrentPlayerId = null;

                Player.Dominos.Remove(domino);
                CurrentGame.CurrentTrick.AddDomino(domino, CurrentGame.Trump.Value);
                await MyGroup.UpdateAsync();

                if (!await ApiClient.MakeMoveAsync(MatchId, domino))
                {
                    CurrentGame.CurrentPlayerId = currentPlayerId;
                    if (!Player.Dominos.Contains(domino))
                    {
                        Player.Dominos.Add(domino);
                        await MyGroup.UpdateAsync();
                    }

                    var index = Array.IndexOf(CurrentGame.CurrentTrick.Dominos, domino);
                    if (index != -1)
                    {
                        CurrentGame.CurrentTrick.Dominos[index] = null;
                    }
                }
            }
            finally
            {
                MakingMove = false;
            }
        }

        protected async Task RegisterSignalRAsync()
        { 
            // TODO: handle signalr connection exceptions (possibly at the app level)

            HubConnection.Reconnected += async (string connectionId) =>
            {
                await FetchMatchAsync();
            };

            HubConnection.On<FortyTwo.Shared.DTO.Match>("OnMatchChanged", async (match) =>
            {
                await FetchPlayerAsync();

                StateHasChanged();

                var newGameStarting = match.Players.All(x => x.Ready) && CurrentGame.Tricks.Count == 0 && CurrentGame.CurrentTrick.IsEmpty();
                if (newGameStarting)
                {
                    if (MyGroup != null)
                    {
                        await MyGroup.UpdateAsync();
                    }

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

                    var biddingTeam = (int)Model.Players.First(x => x.Id == CurrentGame.BiddingPlayerId).Position % 2 == 0
                        ? Teams.TeamA
                        : Teams.TeamB;

                    if (Player.Team == match.WinningTeam)
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

            HubConnection.On<Game>("OnGameChanged", async (game) =>
            {
                if (CurrentGame.CurrentTrick.Dominos.Count(x => x != null) == 3 && game.CurrentTrick.Dominos.All(x => x == null))
                {
                    CurrentGame.CurrentTrick.AddDomino(game.Tricks.Last().Dominos.Last(), CurrentGame.Trump.Value);

                    StateHasChanged();

                    await Task.Delay(1000);
                }

                await UpdateGame(game);

                StateHasChanged();

                await ShowNotificationIfGameOverAsync(game);
            });

            await HubConnection.SendAsync("JoinGameAsync", MatchId);
        }

        public async ValueTask DisposeAsync()
        {
            await HubConnection?.SendAsync("LeaveGameAsync", MatchId);
        }

        public async Task ShowNotificationIfGameOverAsync(Game game)
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

            var biddingTeam = (int)Model.Players.First(x => x.Id == Model.CurrentGame.BiddingPlayerId).Position % 2 == 0
                ? Teams.TeamA
                : Teams.TeamB;

            if (Player.Team == game.WinningTeam)
            {
                alertOptions.Icon = SweetAlertIcon.Success;
                alertOptions.Title = "Victory!";
                alertOptions.Text = biddingTeam == Player.Team
                    ? "Your team made their bid! 🥳🎈"
                    : "You set the other team! 🎉";
            }
            else
            {
                alertOptions.Icon = SweetAlertIcon.Error;
                alertOptions.Title = "Game Over!";
                alertOptions.Text = biddingTeam == Player.Team
                    ? "The other team set you 😡"
                    : "The other team made their bid 😒";
            }

            await Swal.FireAsync(alertOptions);
        }
    }
}
